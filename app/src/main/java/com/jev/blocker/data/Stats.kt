package com.jev.blocker.data

import java.util.concurrent.atomic.AtomicLong

/**
 * Process-wide counters. The service writes, the activity reads.
 */
object Stats {
    val queries = AtomicLong(0)
    val blocked = AtomicLong(0)

    fun reset() {
        queries.set(0)
        blocked.set(0)
    }
}
