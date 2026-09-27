package com.jev.blocker.vpn

import com.jev.blocker.data.DomainSet
import com.jev.blocker.data.Stats
import com.jev.blocker.dns.DnsPacket
import com.jev.blocker.dns.IpPacket
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reads DNS datagrams out of the tunnel, answers blocked names locally, and
 * relays everything else to the resolver the system was already using.
 *
 * Blocked queries never reach the network at all, which is the whole point: a
 * connection to an ad host is refused before a socket is ever opened.
 */
class DnsRelay(
    private val input: FileInputStream,
    private val output: FileOutputStream,
    private val matcher: () -> DomainSet,
    private val protect: (DatagramSocket) -> Boolean,
    private val log: (String) -> Unit
) {

    companion object {
        private const val DNS_PORT = 53
        private const val READ_BUFFER_SIZE = 32_767
        private const val UPSTREAM_TIMEOUT_MS = 4_000
        private const val POOL_SIZE = 8
        private const val FALLBACK_DNS = "1.1.1.1"
        private const val MAX_UPSTREAM_RESPONSE = 4_096
    }

    private val running = AtomicBoolean(false)
    private val writeLock = Any()
    private val pool: ExecutorService = Executors.newFixedThreadPool(POOL_SIZE)

    @Volatile
    private var reader: Thread? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        reader = Thread({ loop() }, "jev-dns-relay").apply {
            isDaemon = true
            start()
        }
    }

    /**
     * The tunnel descriptor is closed by the owning service, which is what
     * unblocks the pending read and lets the loop exit.
     */
    fun stop() {
        running.set(false)
        pool.shutdownNow()
        reader?.interrupt()
        reader = null
    }

    private fun loop() {
        val buffer = ByteArray(READ_BUFFER_SIZE)
        while (running.get()) {
            val read = try {
                input.read(buffer)
            } catch (t: Throwable) {
                if (running.get()) log("tunnel read stopped: ${t.javaClass.simpleName}")
                return
            }
            if (read <= 0) continue
            try {
                handle(buffer, read)
            } catch (_: Throwable) {
                // A malformed packet is not worth crashing the tunnel over.
            }
        }
    }

    private fun handle(buffer: ByteArray, length: Int) {
        val request = IpPacket.parseUdp(buffer, length) ?: return
        if (request.dstPort != DNS_PORT) return

        val dnsLength = request.payloadLength
        if (dnsLength < DnsPacket.MIN_QUERY_SIZE) return
        if (!DnsPacket.isQuery(buffer, request.payloadOffset, dnsLength)) return

        Stats.queries.incrementAndGet()

        val name = DnsPacket.questionName(buffer, request.payloadOffset, dnsLength)
        if (name != null && matcher().isBlocked(name)) {
            Stats.blocked.incrementAndGet()
            val refusal = DnsPacket.nxDomain(buffer, request.payloadOffset, dnsLength) ?: return
            write(IpPacket.buildReply(request, refusal))
            return
        }

        val query = buffer.copyOfRange(
            request.payloadOffset,
            request.payloadOffset + dnsLength
        )
        forward(request, query)
    }

    private fun forward(request: IpPacket.UdpRequest, query: ByteArray) {
        val task = Runnable {
            val response = exchange(request, query)
            if (response != null) write(IpPacket.buildReply(request, response))
        }
        try {
            pool.execute(task)
        } catch (_: Throwable) {
            // Pool is shutting down.
        }
    }

    private fun exchange(request: IpPacket.UdpRequest, query: ByteArray): ByteArray? {
        send(request.dstIp, request.dstPort, query)?.let { return it }

        // The resolver the system handed us did not answer. Fall back so that
        // turning the filter on can never break name resolution entirely.
        return try {
            send(InetAddress.getByName(FALLBACK_DNS).address, DNS_PORT, query)
        } catch (_: Throwable) {
            null
        }
    }

    private fun send(dstIp: ByteArray, dstPort: Int, query: ByteArray): ByteArray? {
        var socket: DatagramSocket? = null
        return try {
            val created = DatagramSocket()
            socket = created
            // Without this the upstream query would re-enter our own tunnel.
            protect(created)
            created.soTimeout = UPSTREAM_TIMEOUT_MS

            val target = InetAddress.getByAddress(dstIp)
            created.send(DatagramPacket(query, query.size, target, dstPort))

            val responseBuffer = ByteArray(MAX_UPSTREAM_RESPONSE)
            val response = DatagramPacket(responseBuffer, responseBuffer.size)
            created.receive(response)
            responseBuffer.copyOf(response.length)
        } catch (_: Throwable) {
            null
        } finally {
            try {
                socket?.close()
            } catch (_: Throwable) {
            }
        }
    }

    private fun write(packet: ByteArray) {
        synchronized(writeLock) {
            try {
                output.write(packet)
            } catch (_: Throwable) {
                // Tunnel is going away.
            }
        }
    }
}
