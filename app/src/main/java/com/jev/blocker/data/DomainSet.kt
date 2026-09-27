package com.jev.blocker.data

/**
 * A set of blocked domains with subdomain semantics: blocking `tracker.com`
 * also blocks `a.tracker.com` and `a.b.tracker.com`.
 *
 * Matching walks the parent chain of the queried host rather than storing every
 * possible subdomain, which keeps a million-entry list at a manageable size.
 */
class DomainSet {

    private val domains = HashSet<String>(1 shl 16)

    val size: Int get() = domains.size

    /** Read-only view of the stored domains, used when persisting to disk. */
    fun snapshot(): Set<String> = domains

    fun clear() = domains.clear()

    /** Adds [raw] if it parses as a usable domain. Returns true when it was new. */
    fun add(raw: String): Boolean {
        val domain = normalize(raw) ?: return false
        return domains.add(domain)
    }

    fun isBlocked(host: String): Boolean {
        val h = normalize(host) ?: return false
        if (domains.isEmpty()) return false
        if (domains.contains(h)) return true

        var idx = h.indexOf('.')
        while (idx >= 0) {
            val parent = h.substring(idx + 1)
            if (domains.contains(parent)) return true
            idx = h.indexOf('.', idx + 1)
        }
        return false
    }

    companion object {

        /**
         * Parses one line of a hosts file, a plain domain list, or a wildcard
         * list such as `*.doubleclick.net`. Returns null for comments, blank
         * lines and anything that is not a plain domain.
         */
        fun parseHostsLine(line: String): String? {
            var s = line.trim()
            if (s.isEmpty()) return null
            if (s.startsWith("#") || s.startsWith("!")) return null

            val comment = s.indexOf('#')
            if (comment >= 0) s = s.substring(0, comment).trim()
            if (s.isEmpty()) return null

            val parts = s.split(' ', '\t').filter { it.isNotEmpty() }
            val host = when {
                parts.size >= 2 -> parts[1]
                parts.size == 1 -> parts[0]
                else -> return null
            }
            return normalize(host)
        }

        /**
         * Reduces a token to a bare lowercase domain, or null when it is not
         * one. Entries containing Adblock-style syntax are rejected rather than
         * guessed at, and entries without a dot are dropped so a malformed list
         * can never take out an entire top-level domain.
         */
        fun normalize(raw: String): String? {
            var s = raw.trim().lowercase()
            if (s.isEmpty()) return null

            if (s.startsWith("*.")) s = s.substring(2)
            else if (s.startsWith(".")) s = s.substring(1)

            while (s.endsWith(".")) s = s.dropLast(1)

            if (s.length < 4 || s.length > 253) return null
            if (!s.contains('.')) return null
            if (s.startsWith("-") || s.endsWith("-")) return null

            for (c in s) {
                val ok = c in 'a'..'z' || c in '0'..'9' || c == '.' || c == '-' || c == '_'
                if (!ok) return null
            }
            if (s.contains("..")) return null
            return s
        }
    }
}
