use std::collections::HashSet;

/// An entry in the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub date: String,
    pub cents: i64,
    pub category: String,
    pub note: String,
}

pub enum Section {
    Essentials,
    Lifestyle,
    Other,
}

pub trait Format {
    fn format_money(&self, cents: i64) -> String;
}

#[derive(Default)]
pub struct Ledger {
    entries: Vec<Entry>,
    keys: HashSet<String>,
}

impl Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, entry: Entry) -> bool {
        let key = format!("{}|{}|{}|{}", entry.date, entry.cents, entry.category, entry.note);
        if !self.keys.insert(key) {
            return false;
        }
        self.entries.push(entry);
        true
    }

    pub fn total(&self, category: Option<&str>) -> i64 {
        self.entries
            .iter()
            .filter(|e| category.map_or(true, |c| e.category == c))
            .map(|e| e.cents)
            .sum()
    }
}

pub fn format_money(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let a = cents.abs();
    format!("{}{}.{:02}", sign, a / 100, a % 100)
}

const MAX_ROWS: usize = 1000;
