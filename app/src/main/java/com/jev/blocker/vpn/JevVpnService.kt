package com.jev.blocker.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.jev.blocker.MainActivity
import com.jev.blocker.R
import com.jev.blocker.data.BlocklistStore
import com.jev.blocker.data.DomainSet
import com.jev.blocker.data.Stats
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress

/**
 * A loopback VPN that captures DNS only.
 *
 * The tunnel is deliberately narrow: it carries a /32 (and /128) route for each
 * DNS server address and nothing else, so all other traffic bypasses it
 * untouched. That means no userspace TCP stack, no added latency on normal
 * browsing, and no need for root.
 */
class JevVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.jev.blocker.action.START"
        const val ACTION_STOP = "com.jev.blocker.action.STOP"
        const val ACTION_RELOAD = "com.jev.blocker.action.RELOAD"

        private const val CHANNEL_ID = "jev_blocker_status"
        private const val NOTIFICATION_ID = 4711
        private const val NOTIFICATION_REFRESH_MS = 5_000L

        private const val TUNNEL_ADDRESS_V4 = "10.111.222.1"
        private const val TUNNEL_ADDRESS_V6 = "fd00:1:2:3::1"
        private const val TUNNEL_PREFIX_V4 = "10.111.222."

        /**
         * Public resolvers added on top of whatever the active network hands
         * us, so apps that hardcode their own resolver are still filtered.
         */
        private val COMMON_RESOLVERS = listOf(
            "8.8.8.8", "8.8.4.4",
            "1.1.1.1", "1.0.0.1",
            "9.9.9.9", "149.112.112.112",
            "208.67.222.222", "208.67.220.220",
            "64.6.64.6", "64.6.65.6",
            "77.88.8.8", "77.88.8.1",
            "94.140.14.14", "94.140.15.15",
            "185.228.168.9", "185.228.169.9",
            "76.76.2.0", "76.76.19.19",
            "156.154.70.1", "156.154.71.1",
            "84.200.69.80", "84.200.70.40",
            "8.26.56.26", "8.20.247.20",
            "37.235.1.174", "37.235.1.177",
            "216.146.35.35", "216.146.36.36",
            "180.76.76.76", "119.29.29.29",
            "223.5.5.5", "223.6.6.6",
            "114.114.114.114", "114.114.115.115",
            "101.226.4.6", "218.30.118.6",
            "2606:4700:4700::1111", "2606:4700:4700::1001",
            "2001:4860:4860::8888", "2001:4860:4860::8844",
            "2620:fe::fe", "2620:fe::9",
            "2400:3200::1", "2400:3200:baba::1"
        )

        @Volatile
        var isRunning: Boolean = false
            private set

        fun start(context: Context) {
            val intent = Intent(context, JevVpnService::class.java).setAction(ACTION_START)
            context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, JevVpnService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }

        fun reload(context: Context) {
            val intent = Intent(context, JevVpnService::class.java).setAction(ACTION_RELOAD)
            context.startService(intent)
        }
    }

    private var tunnel: ParcelFileDescriptor? = null
    private var relay: DnsRelay? = null
    private var input: FileInputStream? = null
    private var output: FileOutputStream? = null

    @Volatile
    private var blocklist: DomainSet = DomainSet()

    private val handler = Handler(Looper.getMainLooper())
    private val notificationTicker = object : Runnable {
        override fun run() {
            refreshNotification()
            if (isRunning) handler.postDelayed(this, NOTIFICATION_REFRESH_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopFiltering()
                stopSelf()
            }

            ACTION_RELOAD -> {
                loadBlocklist()
                refreshNotification()
            }

            else -> startFiltering()
        }
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        stopFiltering()
        stopSelf()
        super.onRevoke()
    }

    override fun onDestroy() {
        stopFiltering()
        super.onDestroy()
    }

    private fun startFiltering() {
        if (relay != null) return

        loadBlocklist()

        val descriptor = try {
            establishTunnel()
        } catch (_: Throwable) {
            null
        }

        if (descriptor == null) {
            isRunning = false
            stopSelf()
            return
        }

        tunnel = descriptor
        val inStream = FileInputStream(descriptor.fileDescriptor)
        val outStream = FileOutputStream(descriptor.fileDescriptor)
        input = inStream
        output = outStream

        relay = DnsRelay(
            input = inStream,
            output = outStream,
            matcher = { blocklist },
            protect = { socket: DatagramSocket -> protect(socket) },
            log = { /* keep the tunnel quiet */ }
        ).also { it.start() }

        isRunning = true
        startForegroundCompat()
        handler.removeCallbacks(notificationTicker)
        handler.post(notificationTicker)
    }

    private fun stopFiltering() {
        handler.removeCallbacks(notificationTicker)
        isRunning = false
        relay?.stop()
        relay = null
        input = null
        output = null

        // Closing the descriptor unblocks the reader thread in the relay.
        try {
            tunnel?.close()
        } catch (_: Throwable) {
        }
        tunnel = null

        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Throwable) {
        }
        try {
            NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
        } catch (_: Throwable) {
        }
    }

    private fun loadBlocklist() {
        val loaded = DomainSet()
        try {
            BlocklistStore(applicationContext).loadInto(loaded)
        } catch (_: Throwable) {
        }
        blocklist = loaded
    }

    private fun establishTunnel(): ParcelFileDescriptor? {
        val builder = Builder()
        builder.setSession(getString(R.string.app_name))
        builder.setMtu(1500)
        builder.addAddress(TUNNEL_ADDRESS_V4, 32)
        builder.addAddress(TUNNEL_ADDRESS_V6, 128)

        for (server in dnsServerAddresses()) {
            try {
                val address = InetAddress.getByName(server)
                val prefix = if (address is Inet4Address) 32 else 128
                builder.addRoute(address, prefix)
            } catch (_: Throwable) {
            }
        }

        // Our own traffic must never enter the tunnel, otherwise the relayed
        // upstream queries would loop straight back into us.
        try {
            builder.addDisallowedApplication(packageName)
        } catch (_: Throwable) {
        }

        // Traffic that matches no route keeps using the underlying network.
        builder.setBlocking(false)
        return builder.establish()
    }

    private fun dnsServerAddresses(): List<String> {
        val addresses = LinkedHashSet<String>()
        try {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            for (network in manager.allNetworks) {
                val properties = manager.getLinkProperties(network) ?: continue
                for (address in properties.dnsServers) {
                    val host = address.hostAddress ?: continue
                    if (isOurOwnAddress(host)) continue
                    addresses.add(host)
                }
            }
        } catch (_: Throwable) {
        }
        addresses.addAll(COMMON_RESOLVERS)
        return addresses.toList()
    }

    private fun isOurOwnAddress(host: String): Boolean =
        host.startsWith(TUNNEL_PREFIX_V4) || host.startsWith("fd00:1:2:3")

    private fun createNotificationChannel() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, JevVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_shield)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(
                getString(R.string.notif_text, Stats.blocked.get(), Stats.queries.get())
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .addAction(0, getString(R.string.action_stop), stop)
            .build()
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun refreshNotification() {
        if (!isRunning) return
        try {
            NotificationManagerCompat.from(this)
                .notify(NOTIFICATION_ID, buildNotification())
        } catch (_: Throwable) {
        }
    }
}
