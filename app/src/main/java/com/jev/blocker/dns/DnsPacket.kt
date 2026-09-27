package com.jev.blocker.dns

/**
 * Minimal DNS wire-format handling. Only what a filtering resolver needs:
 * read the question name, and synthesise an NXDOMAIN answer.
 *
 * Every function takes an explicit [offset] into a larger buffer so callers can
 * work straight on the UDP payload inside an IP packet without copying.
 */
object DnsPacket {

    const val HEADER_SIZE = 12
    const val MIN_QUERY_SIZE = HEADER_SIZE + 5

    private const val FLAG_QR = 0x8000
    private const val RCODE_NXDOMAIN = 3

    /** True when the QR bit is clear, i.e. this is a query and not a response. */
    fun isQuery(buf: ByteArray, offset: Int, len: Int): Boolean {
        if (len < HEADER_SIZE || offset + HEADER_SIZE > buf.size) return false
        val flags = ((buf[offset + 2].toInt() and 0xFF) shl 8) or
            (buf[offset + 3].toInt() and 0xFF)
        return (flags and FLAG_QR) == 0
    }

    /**
     * Reads the QNAME as a dotted lowercase string, or null when the message is
     * malformed. Compression pointers are rejected: they are illegal in the
     * question section, so their presence means the packet is not something we
     * should try to interpret.
     */
    fun questionName(buf: ByteArray, offset: Int, len: Int): String? {
        if (len < MIN_QUERY_SIZE) return null
        val end = offset + len
        if (end > buf.size) return null

        val sb = StringBuilder(32)
        var i = offset + HEADER_SIZE
        while (i < end) {
            val labelLen = buf[i].toInt() and 0xFF
            if (labelLen == 0) {
                return if (sb.length == 0) null else sb.toString()
            }
            if (labelLen > 63) return null
            if (i + 1 + labelLen > end) return null
            if (sb.length > 0) sb.append('.')
            for (j in 0 until labelLen) {
                sb.append((buf[i + 1 + j].toInt() and 0xFF).toChar())
            }
            i += labelLen + 1
            if (sb.length > 253) return null
        }
        return null
    }

    /** Length of the question section (QNAME + QTYPE + QCLASS), or -1 if malformed. */
    fun questionLength(buf: ByteArray, offset: Int, len: Int): Int {
        if (len < MIN_QUERY_SIZE) return -1
        val end = offset + len
        if (end > buf.size) return -1

        var i = offset + HEADER_SIZE
        while (i < end) {
            val labelLen = buf[i].toInt() and 0xFF
            if (labelLen == 0) {
                val questionEnd = i + 5
                return if (questionEnd <= end) questionEnd - offset else -1
            }
            if (labelLen > 63) return -1
            i += labelLen + 1
        }
        return -1
    }

    /**
     * Builds an NXDOMAIN response that echoes the original question. No answer
     * records are emitted, so the reply is always small enough for UDP and the
     * client fails the lookup immediately instead of hanging.
     */
    fun nxDomain(query: ByteArray, offset: Int, len: Int): ByteArray? {
        val questionLen = questionLength(query, offset, len)
        if (questionLen < 0) return null

        val out = ByteArray(HEADER_SIZE + questionLen)
        System.arraycopy(query, offset, out, 0, HEADER_SIZE)

        // QR=1, RD=1
        out[2] = 0x81.toByte()
        // RA=1, RCODE=3 (NXDOMAIN)
        out[3] = (0x80 or RCODE_NXDOMAIN).toByte()
        // ANCOUNT, NSCOUNT and ARCOUNT are all zero. Dropping the OPT record is
        // deliberate: it keeps the reply minimal and is accepted in practice.
        for (i in 6..11) out[i] = 0.toByte()

        System.arraycopy(query, offset + HEADER_SIZE, out, HEADER_SIZE, questionLen)
        return out
    }
}
