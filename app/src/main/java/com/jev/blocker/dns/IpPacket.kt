package com.jev.blocker.dns

/**
 * Parses UDP datagrams out of raw IPv4/IPv6 packets and builds the replies.
 *
 * The tunnel only ever carries DNS traffic, because the VPN is configured with
 * /32 and /128 routes for DNS server addresses alone. Everything else bypasses
 * the tunnel untouched, which is why no TCP handling exists here.
 */
object IpPacket {

    const val PROTO_UDP = 17

    class UdpRequest(
        val version: Int,
        val srcIp: ByteArray,
        val dstIp: ByteArray,
        val srcPort: Int,
        val dstPort: Int,
        val payloadOffset: Int,
        val payloadLength: Int
    )

    fun parseUdp(buf: ByteArray, len: Int): UdpRequest? {
        if (len < 20) return null
        return when ((buf[0].toInt() and 0xF0) shr 4) {
            4 -> parseUdp4(buf, len)
            6 -> parseUdp6(buf, len)
            else -> null
        }
    }

    private fun parseUdp4(buf: ByteArray, len: Int): UdpRequest? {
        val ihl = (buf[0].toInt() and 0x0F) * 4
        if (ihl < 20 || len < ihl + 8) return null
        if ((buf[9].toInt() and 0xFF) != PROTO_UDP) return null

        val totalLen = u16(buf, 2)
        val udpLen = u16(buf, ihl + 4)
        if (udpLen < 8) return null

        val payloadOffset = ihl + 8
        var payloadLength = udpLen - 8
        payloadLength = minOf(payloadLength, len - payloadOffset)
        if (totalLen >= payloadOffset) payloadLength = minOf(payloadLength, totalLen - payloadOffset)
        if (payloadLength <= 0) return null

        return UdpRequest(
            version = 4,
            srcIp = buf.copyOfRange(12, 16),
            dstIp = buf.copyOfRange(16, 20),
            srcPort = u16(buf, ihl),
            dstPort = u16(buf, ihl + 2),
            payloadOffset = payloadOffset,
            payloadLength = payloadLength
        )
    }

    private fun parseUdp6(buf: ByteArray, len: Int): UdpRequest? {
        if (len < 48) return null
        // Extension headers are not walked: DNS does not use them in practice.
        if ((buf[6].toInt() and 0xFF) != PROTO_UDP) return null

        val payloadLen = u16(buf, 4)
        if (payloadLen < 8) return null

        val payloadOffset = 48
        val payloadLength = minOf(payloadLen - 8, len - payloadOffset)
        if (payloadLength <= 0) return null

        return UdpRequest(
            version = 6,
            srcIp = buf.copyOfRange(8, 24),
            dstIp = buf.copyOfRange(24, 40),
            srcPort = u16(buf, 40),
            dstPort = u16(buf, 42),
            payloadOffset = payloadOffset,
            payloadLength = payloadLength
        )
    }

    fun buildReply(req: UdpRequest, payload: ByteArray): ByteArray =
        if (req.version == 4) buildReply4(req, payload) else buildReply6(req, payload)

    private fun buildReply4(req: UdpRequest, payload: ByteArray): ByteArray {
        val udpLen = 8 + payload.size
        val total = 20 + udpLen
        val p = ByteArray(total)

        p[0] = 0x45
        p[1] = 0
        p[2] = ((total shr 8) and 0xFF).toByte()
        p[3] = (total and 0xFF).toByte()
        p[4] = 0
        p[5] = 0
        p[6] = 0x40.toByte()
        p[7] = 0
        p[8] = 64
        p[9] = PROTO_UDP.toByte()
        p[10] = 0
        p[11] = 0

        System.arraycopy(req.dstIp, 0, p, 12, 4)
        System.arraycopy(req.srcIp, 0, p, 16, 4)

        val header = checksum(p, 0, 20)
        p[10] = ((header shr 8) and 0xFF).toByte()
        p[11] = (header and 0xFF).toByte()

        writeUdpHeader(p, 20, req.dstPort, req.srcPort, udpLen)
        // A zero UDP checksum means "not computed", which IPv4 permits.
        p[26] = 0
        p[27] = 0

        System.arraycopy(payload, 0, p, 28, payload.size)
        return p
    }

    private fun buildReply6(req: UdpRequest, payload: ByteArray): ByteArray {
        val udpLen = 8 + payload.size
        val p = ByteArray(40 + udpLen)

        p[0] = 0x60.toByte()
        p[1] = 0
        p[2] = 0
        p[3] = 0
        p[4] = ((udpLen shr 8) and 0xFF).toByte()
        p[5] = (udpLen and 0xFF).toByte()
        p[6] = PROTO_UDP.toByte()
        p[7] = 64

        System.arraycopy(req.dstIp, 0, p, 8, 16)
        System.arraycopy(req.srcIp, 0, p, 24, 16)

        writeUdpHeader(p, 40, req.dstPort, req.srcPort, udpLen)

        // The payload has to be in place before the checksum is taken.
        System.arraycopy(payload, 0, p, 48, payload.size)

        // IPv6 requires a real UDP checksum; there is no "not computed" value.
        val udpChecksum = checksum6(req.dstIp, req.srcIp, p, 40, udpLen)
        p[46] = ((udpChecksum shr 8) and 0xFF).toByte()
        p[47] = (udpChecksum and 0xFF).toByte()

        return p
    }

    private fun writeUdpHeader(
        p: ByteArray,
        offset: Int,
        srcPort: Int,
        dstPort: Int,
        udpLen: Int
    ) {
        p[offset] = ((srcPort shr 8) and 0xFF).toByte()
        p[offset + 1] = (srcPort and 0xFF).toByte()
        p[offset + 2] = ((dstPort shr 8) and 0xFF).toByte()
        p[offset + 3] = (dstPort and 0xFF).toByte()
        p[offset + 4] = ((udpLen shr 8) and 0xFF).toByte()
        p[offset + 5] = (udpLen and 0xFF).toByte()
        p[offset + 6] = 0
        p[offset + 7] = 0
    }

    private fun u16(buf: ByteArray, i: Int): Int =
        ((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)

    private fun checksum(buf: ByteArray, offset: Int, length: Int): Int {
        var sum = 0L
        var i = offset
        val end = offset + length
        while (i + 1 < end) {
            sum += u16(buf, i).toLong()
            i += 2
        }
        if (i < end) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        return sum.inv().toInt() and 0xFFFF
    }

    private fun checksum6(
        srcIp: ByteArray,
        dstIp: ByteArray,
        udp: ByteArray,
        offset: Int,
        udpLen: Int
    ): Int {
        var sum = 0L
        var i = 0
        while (i < 16) {
            sum += u16(srcIp, i).toLong()
            i += 2
        }
        i = 0
        while (i < 16) {
            sum += u16(dstIp, i).toLong()
            i += 2
        }
        sum += (udpLen and 0xFFFF).toLong()
        sum += PROTO_UDP.toLong()

        i = offset
        val end = offset + udpLen
        while (i + 1 < end) {
            sum += u16(udp, i).toLong()
            i += 2
        }
        if (i < end) sum += ((udp[i].toInt() and 0xFF) shl 8).toLong()

        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        val folded = sum.inv().toInt() and 0xFFFF
        // A computed zero must be transmitted as 0xFFFF, otherwise it would be
        // read as "no checksum" and the datagram dropped.
        return if (folded == 0) 0xFFFF else folded
    }
}
