package com.jev.blocker

import com.jev.blocker.data.DomainSet
import com.jev.blocker.dns.DnsPacket
import com.jev.blocker.dns.IpPacket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DnsPacketTest {

    private fun dnsQuery(name: String, id: Int = 0x1234): ByteArray {
        val labels = name.split('.')
        val size = 12 + labels.sumOf { it.length + 1 } + 1 + 4
        val out = ByteArray(size)

        out[0] = ((id shr 8) and 0xFF).toByte()
        out[1] = (id and 0xFF).toByte()
        out[2] = 0x01.toByte()
        out[3] = 0
        out[4] = 0
        out[5] = 1
        out[6] = 0
        out[7] = 0
        out[8] = 0
        out[9] = 0
        out[10] = 0
        out[11] = 0

        var i = 12
        for (label in labels) {
            out[i] = label.length.toByte()
            for (j in label.indices) {
                out[i + 1 + j] = label[j].code.toByte()
            }
            i += label.length + 1
        }
        out[i] = 0
        i += 1
        out[i] = 0
        out[i + 1] = 1
        out[i + 2] = 0
        out[i + 3] = 1
        return out
    }

    @Test
    fun readsQuestionName() {
        val query = dnsQuery("ads.tracker.example.com")
        assertEquals(
            "ads.tracker.example.com",
            DnsPacket.questionName(query, 0, query.size)
        )
    }

    @Test
    fun reportsQuestionLength() {
        val query = dnsQuery("a.io")
        // 12 byte header + (1+1) + (2+1) + terminator + 4 bytes of type and class
        assertEquals(12 + 2 + 3 + 1 + 4, DnsPacket.questionLength(query, 0, query.size))
    }

    @Test
    fun recognisesQueriesAndNotResponses() {
        val query = dnsQuery("example.com")
        assertTrue(DnsPacket.isQuery(query, 0, query.size))

        val response = query.copyOf()
        response[2] = (response[2].toInt() or 0x80).toByte()
        assertFalse(DnsPacket.isQuery(response, 0, response.size))
    }

    @Test
    fun buildsNxDomainThatEchoesTheQuestion() {
        val query = dnsQuery("ads.example.com")
        val reply = DnsPacket.nxDomain(query, 0, query.size)
        assertNotNull(reply)

        val r = reply!!
        assertEquals(query.size, r.size)

        // Transaction id is preserved so the client can match the answer.
        assertEquals(query[0], r[0])
        assertEquals(query[1], r[1])

        // QR set, RD set.
        assertEquals(0x81, r[2].toInt() and 0xFF)
        // RA set, RCODE 3 (NXDOMAIN).
        assertEquals(0x83, r[3].toInt() and 0xFF)
        assertEquals(3, r[3].toInt() and 0x0F)

        // No answers, authority or additional records.
        for (i in 6..11) assertEquals(0, r[i].toInt())

        // Question section is byte-identical.
        for (i in 12 until query.size) assertEquals(query[i], r[i])
    }

    @Test
    fun rejectsTruncatedMessages() {
        val query = dnsQuery("example.com")
        assertNull(DnsPacket.questionName(query, 0, 5))
        assertNull(DnsPacket.questionName(query, 0, 12))
        assertEquals(-1, DnsPacket.questionLength(query, 0, 12))
    }
}

class DomainSetTest {

    @Test
    fun blocksExactAndSubdomains() {
        val set = DomainSet()
        set.add("doubleclick.net")

        assertTrue(set.isBlocked("doubleclick.net"))
        assertTrue(set.isBlocked("ad.doubleclick.net"))
        assertTrue(set.isBlocked("a.b.c.doubleclick.net"))
        assertTrue(set.isBlocked("DOUBLECLICK.NET"))
        assertTrue(set.isBlocked("ad.doubleclick.net."))

        assertFalse(set.isBlocked("notdoubleclick.net"))
        assertFalse(set.isBlocked("doubleclick.net.example.com"))
        assertFalse(set.isBlocked("example.com"))
    }

    @Test
    fun parsesHostsAndPlainFormats() {
        assertEquals("ads.example.com", DomainSet.parseHostsLine("0.0.0.0 ads.example.com"))
        assertEquals("ads.example.com", DomainSet.parseHostsLine("127.0.0.1 ads.example.com"))
        assertEquals("ads.example.com", DomainSet.parseHostsLine("ads.example.com"))
        assertEquals("ads.example.com", DomainSet.parseHostsLine("  ads.example.com  "))
        assertEquals("ads.example.com", DomainSet.parseHostsLine("ads.example.com # comment"))
        assertEquals("doubleclick.net", DomainSet.parseHostsLine("*.doubleclick.net"))

        assertNull(DomainSet.parseHostsLine(""))
        assertNull(DomainSet.parseHostsLine("# comment"))
        assertNull(DomainSet.parseHostsLine("!"))
        assertNull(DomainSet.parseHostsLine("||ads.example.com^"))
    }

    @Test
    fun refusesEntriesThatCouldBreakResolution() {
        val set = DomainSet()
        // A bare TLD would take out the whole internet, so it must be dropped.
        assertFalse(set.add("com"))
        assertFalse(set.add("io"))
        assertFalse(set.add("localhost"))
        assertFalse(set.add("has space.com"))
        assertFalse(set.add("http://example.com/path"))
        assertEquals(0, set.size)
    }
}

class IpPacketTest {

    private fun ipv4UdpPacket(
        srcIp: IntArray,
        dstIp: IntArray,
        srcPort: Int,
        dstPort: Int,
        payload: ByteArray
    ): ByteArray {
        val udpLen = 8 + payload.size
        val total = 20 + udpLen
        val p = ByteArray(total)

        p[0] = 0x45
        p[2] = ((total shr 8) and 0xFF).toByte()
        p[3] = (total and 0xFF).toByte()
        p[8] = 64
        p[9] = IpPacket.PROTO_UDP.toByte()
        for (k in 0..3) {
            p[12 + k] = srcIp[k].toByte()
            p[16 + k] = dstIp[k].toByte()
        }
        val sum = headerChecksum(p, 0, 20)
        p[10] = ((sum shr 8) and 0xFF).toByte()
        p[11] = (sum and 0xFF).toByte()

        p[20] = ((srcPort shr 8) and 0xFF).toByte()
        p[21] = (srcPort and 0xFF).toByte()
        p[22] = ((dstPort shr 8) and 0xFF).toByte()
        p[23] = (dstPort and 0xFF).toByte()
        p[24] = ((udpLen shr 8) and 0xFF).toByte()
        p[25] = (udpLen and 0xFF).toByte()
        System.arraycopy(payload, 0, p, 28, payload.size)
        return p
    }

    private fun headerChecksum(buf: ByteArray, offset: Int, length: Int): Int {
        var sum = 0L
        var i = offset
        val end = offset + length
        while (i + 1 < end) {
            sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong()
            i += 2
        }
        if (i < end) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        return sum.inv().toInt() and 0xFFFF
    }

    private fun foldSum(buf: ByteArray, offset: Int, length: Int): Int {
        var sum = 0L
        var i = offset
        val end = offset + length
        while (i + 1 < end) {
            sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong()
            i += 2
        }
        if (i < end) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        return sum.toInt() and 0xFFFF
    }

    @Test
    fun parsesIpv4UdpDatagram() {
        val payload = byteArrayOf(1, 2, 3, 4)
        val packet = ipv4UdpPacket(
            srcIp = intArrayOf(192, 168, 1, 50),
            dstIp = intArrayOf(8, 8, 8, 8),
            srcPort = 40000,
            dstPort = 53,
            payload = payload
        )

        val parsed = IpPacket.parseUdp(packet, packet.size)
        assertNotNull(parsed)

        val req = parsed!!
        assertEquals(4, req.version)
        assertEquals(40000, req.srcPort)
        assertEquals(53, req.dstPort)
        assertEquals(4, req.payloadLength)
        assertEquals(28, req.payloadOffset)
        assertEquals(192.toByte(), req.srcIp[0])
        assertEquals(8.toByte(), req.dstIp[0])
        assertEquals(1.toByte(), packet[req.payloadOffset])
    }

    @Test
    fun ignoresNonUdpTraffic() {
        val packet = ipv4UdpPacket(
            srcIp = intArrayOf(10, 0, 0, 1),
            dstIp = intArrayOf(10, 0, 0, 2),
            srcPort = 1234,
            dstPort = 53,
            payload = byteArrayOf(1)
        )
        packet[9] = 6 // TCP
        assertNull(IpPacket.parseUdp(packet, packet.size))
    }

    @Test
    fun buildsIpv4ReplyWithValidChecksumAndSwappedAddresses() {
        val query = ByteArray(20) { it.toByte() }
        val request = ipv4UdpPacket(
            srcIp = intArrayOf(192, 168, 1, 50),
            dstIp = intArrayOf(8, 8, 8, 8),
            srcPort = 40000,
            dstPort = 53,
            payload = query
        )
        val parsed = IpPacket.parseUdp(request, request.size)!!

        val reply = IpPacket.buildReply(parsed, ByteArray(12) { 9 })
        assertEquals(20 + 8 + 12, reply.size)

        // Addresses and ports are swapped: the answer comes back from port 53.
        assertEquals(8.toByte(), reply[12])
        assertEquals(192.toByte(), reply[16])
        assertEquals(53, ((reply[20].toInt() and 0xFF) shl 8) or (reply[21].toInt() and 0xFF))
        assertEquals(40000, ((reply[22].toInt() and 0xFF) shl 8) or (reply[23].toInt() and 0xFF))

        // Summing a correct header, checksum field included, yields 0xFFFF.
        assertEquals(0xFFFF, foldSum(reply, 0, 20))
    }

    private fun word(buf: ByteArray, i: Int): Long =
        (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong()

    /**
     * Recomputes an IPv6 UDP checksum with the stored field zeroed. The
     * pseudo-header means the result cannot simply be folded to 0xFFFF, so it
     * has to be recomputed and compared.
     */
    private fun udp6ChecksumOf(
        srcIp: ByteArray,
        dstIp: ByteArray,
        udp: ByteArray,
        offset: Int,
        udpLen: Int
    ): Int {
        val body = udp.copyOfRange(offset, offset + udpLen)
        body[6] = 0
        body[7] = 0

        var sum = 0L
        var i = 0
        while (i < 16) {
            sum += word(srcIp, i)
            i += 2
        }
        i = 0
        while (i < 16) {
            sum += word(dstIp, i)
            i += 2
        }
        sum += (udpLen and 0xFFFF).toLong()
        sum += IpPacket.PROTO_UDP.toLong()

        i = 0
        while (i + 1 < udpLen) {
            sum += word(body, i)
            i += 2
        }
        if (i < udpLen) sum += ((body[i].toInt() and 0xFF) shl 8).toLong()

        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        val folded = sum.inv().toInt() and 0xFFFF
        return if (folded == 0) 0xFFFF else folded
    }

    @Test
    fun buildsIpv6ReplyWithMandatoryChecksum() {
        val src = ByteArray(16) { 0x20 }
        val dst = ByteArray(16) { 0x30 }
        val query = ByteArray(24) { it.toByte() }

        val header = ByteArray(48 + query.size)
        header[0] = 0x60
        header[4] = 0
        header[5] = (8 + query.size).toByte()
        header[6] = IpPacket.PROTO_UDP.toByte()
        header[7] = 64
        System.arraycopy(src, 0, header, 8, 16)
        System.arraycopy(dst, 0, header, 24, 16)
        header[40] = 0
        header[41] = 53
        header[42] = 0x9C.toByte()
        header[43] = 0x40
        header[44] = 0
        header[45] = (8 + query.size).toByte()
        System.arraycopy(query, 0, header, 48, query.size)

        val parsed = IpPacket.parseUdp(header, header.size)
        assertNotNull(parsed)
        assertEquals(6, parsed!!.version)
        assertEquals(53, parsed.srcPort)
        assertEquals(40000, parsed.dstPort)
        assertEquals(query.size, parsed.payloadLength)

        val reply = IpPacket.buildReply(parsed, query)
        assertEquals(40 + 8 + query.size, reply.size)

        // Addresses and ports are swapped.
        assertEquals(0x30.toByte(), reply[8])
        assertEquals(0x20.toByte(), reply[24])
        assertEquals(40000, ((reply[40].toInt() and 0xFF) shl 8) or (reply[41].toInt() and 0xFF))
        assertEquals(53, ((reply[42].toInt() and 0xFF) shl 8) or (reply[43].toInt() and 0xFF))

        val udpChecksum =
            ((reply[46].toInt() and 0xFF) shl 8) or (reply[47].toInt() and 0xFF)
        assertTrue("IPv6 UDP checksum must not be zero", udpChecksum != 0)

        // The reply swaps the addresses, so the pseudo-header is reversed too.
        assertEquals(
            udpChecksum,
            udp6ChecksumOf(parsed.dstIp, parsed.srcIp, reply, 40, 8 + query.size)
        )

        val corrupted = reply.copyOf()
        corrupted[60] = (corrupted[60].toInt() xor 0xFF).toByte()
        assertFalse(
            "A corrupted payload must not verify",
            udpChecksum == udp6ChecksumOf(parsed.dstIp, parsed.srcIp, corrupted, 40, 8 + query.size)
        )
    }
}
