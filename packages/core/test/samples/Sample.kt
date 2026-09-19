package com.example.ledger

import java.time.LocalDate
import kotlin.math.abs

/** An entry in the ledger. */
data class Entry(val date: LocalDate, val cents: Long, val category: String, val note: String = "")

sealed interface Result {
    data class Ok(val value: Long) : Result
    data class Err(val message: String) : Result
}

object Categories {
    val ALIASES: Map<String, String> = mapOf(
        "groceries" to "food",
        "bus" to "transport",
    )

    fun normalize(input: String): String = ALIASES[input.trim().lowercase()] ?: input.trim().lowercase()
}

class Ledger {
    private val entries = mutableListOf<Entry>()
    private val keys = HashSet<String>()

    fun add(entry: Entry): Boolean {
        val key = "${entry.date}|${entry.cents}|${entry.category}|${entry.note}"
        if (!keys.add(key)) return false
        entries.add(entry)
        return true
    }

    fun total(category: String? = null): Long =
        entries.filter { category == null || it.category == category }.sumOf { it.cents }

    companion object {
        fun empty() = Ledger()
    }
}

fun formatMoney(cents: Long): String {
    val sign = if (cents < 0) "-" else ""
    val a = abs(cents)
    return "$sign${a / 100}.${(a % 100).toString().padStart(2, '0')}"
}
