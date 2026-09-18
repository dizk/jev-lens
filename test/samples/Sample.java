package com.example.ledger;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * In-memory ledger.
 */
public class Ledger {
    private final List<Entry> entries = new ArrayList<>();
    private final Set<String> keys = new HashSet<>();

    public Ledger() {
    }

    public boolean add(Entry entry) {
        String key = entry.date() + "|" + entry.cents() + "|" + entry.category();
        if (!keys.add(key)) {
            return false;
        }
        entries.add(entry);
        return true;
    }

    public long total(String category) {
        long sum = 0;
        for (Entry e : entries) {
            if (category == null || category.equals(e.category())) {
                sum += e.cents();
            }
        }
        return sum;
    }

    public record Entry(LocalDate date, long cents, String category, String note) {
    }
}

interface Formatter {
    String formatMoney(long cents);
}

enum Section {
    ESSENTIALS, LIFESTYLE, OTHER
}
