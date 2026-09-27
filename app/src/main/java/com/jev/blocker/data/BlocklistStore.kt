package com.jev.blocker.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/**
 * Owns the on-disk blocklist. The app ships a small starter list in assets so
 * it works offline on first launch; [update] replaces it with merged public
 * lists.
 */
class BlocklistStore(private val context: Context) {

    companion object {
        private const val FILE_NAME = "blocklist.txt"
        private const val TEMP_NAME = "blocklist.txt.tmp"
        private const val MAX_DOMAINS = 600_000
        private const val TIMEOUT_MS = 20_000

        val SOURCES = listOf(
            "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
            "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
            "https://raw.githubusercontent.com/badmojr/1Hosts/master/Lite/hosts.txt",
            "https://small.oisd.nl/domainswild"
        )
    }

    private val file: File get() = File(context.filesDir, FILE_NAME)

    fun exists(): Boolean = file.exists() && file.length() > 0L

    /** Copies the bundled list into place when nothing is stored yet. */
    fun ensureSeeded(): Int {
        if (exists()) return loadInto(DomainSet())
        return try {
            context.assets.open("blocklist.txt").use { input ->
                file.outputStream().use { output -> input.copyTo(output) }
            }
            loadInto(DomainSet())
        } catch (_: Throwable) {
            0
        }
    }

    fun loadInto(target: DomainSet): Int {
        target.clear()
        if (!exists()) return 0
        var count = 0
        try {
            file.bufferedReader().useLines { lines ->
                for (line in lines) {
                    val domain = DomainSet.parseHostsLine(line) ?: continue
                    if (target.add(domain)) count++
                }
            }
        } catch (_: Throwable) {
            return target.size
        }
        return count
    }

    /**
     * Downloads every source, merges them with the bundled starter list, and
     * swaps the result in. A failing source is skipped rather than aborting the
     * whole update, and the swap is atomic so a crash mid-write cannot leave an
     * empty list behind.
     *
     * [onProgress] is invoked on the IO dispatcher.
     */
    suspend fun update(onProgress: (String) -> Unit = {}): Result<Int> =
        withContext(Dispatchers.IO) {
            runCatching {
                val merged = DomainSet()
                readBundledInto(merged)

                for (source in SOURCES) {
                    onProgress(source)
                    try {
                        fetch(source).lineSequence().forEach { line ->
                            if (merged.size >= MAX_DOMAINS) return@forEach
                            val domain = DomainSet.parseHostsLine(line) ?: return@forEach
                            merged.add(domain)
                        }
                    } catch (_: Throwable) {
                        // Skip this source and keep whatever we already have.
                    }
                }

                if (merged.size == 0) error("no domains could be loaded")
                writeAtomically(merged)
                merged.size
            }
        }

    private fun readBundledInto(target: DomainSet) {
        try {
            context.assets.open("blocklist.txt").bufferedReader().useLines { lines ->
                for (line in lines) {
                    val domain = DomainSet.parseHostsLine(line) ?: continue
                    target.add(domain)
                }
            }
        } catch (_: Throwable) {
        }
    }

    private fun writeAtomically(source: DomainSet) {
        val temp = File(context.filesDir, TEMP_NAME)
        temp.bufferedWriter().use { writer ->
            for (domain in source.snapshot()) {
                writer.write(domain)
                writer.newLine()
            }
        }
        if (file.exists() && !file.delete()) error("could not replace existing blocklist")
        if (!temp.renameTo(file)) error("could not move the new blocklist into place")
    }

    private fun fetch(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            requestMethod = "GET"
            setRequestProperty("User-Agent", "JevBlocker/0.1 (+android)")
            setRequestProperty("Accept-Encoding", "gzip")
            instanceFollowRedirects = true
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) error("HTTP $code")
            val stream = connection.inputStream
            val encoding = connection.contentEncoding
            val text = if (encoding != null && encoding.contains("gzip", ignoreCase = true)) {
                GZIPInputStream(stream).bufferedReader().use { it.readText() }
            } else {
                stream.bufferedReader().use { it.readText() }
            }
            return text
        } finally {
            connection.disconnect()
        }
    }
}
