//! The CPU core temperatures in the SMC: the same keys Stats averages and
//! maxes for "Hottest CPU" (exelban/stats, `Modules/Sensors/values.swift`,
//! MIT: the `group: .CPU`, `type: .temperature`, `average: true` entries).
//! The emergency stop watches the hottest of them besides desk's own sensor
//! (thermal.rs), which on Apple Silicon reads well below the cores under load.
//! A new chip needs its list here; until then `chip` does not know it.

use crate::fan_control::Smc;
use crate::thermal::hottest;

/// The Apple chips Stats knows CPU core keys for (Pro, Max and Ultra share
/// their generation's keys).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chip {
    M1,
    M2,
    M3,
    M4,
    M5,
    M6,
    A18Pro,
}

/// The chip from `machdep.cpu.brand_string` ("Apple M3 Pro"); None for an
/// Intel Mac or a chip this list does not know yet.
pub fn chip(brand: &str) -> Option<Chip> {
    let mut words = brand.strip_prefix("Apple ")?.split_whitespace();
    match words.next()? {
        "M1" => Some(Chip::M1),
        "M2" => Some(Chip::M2),
        "M3" => Some(Chip::M3),
        "M4" => Some(Chip::M4),
        "M5" => Some(Chip::M5),
        "M6" => Some(Chip::M6),
        "A18" if words.next() == Some("Pro") => Some(Chip::A18Pro),
        _ => None,
    }
}

const M1: &[&str] = &["Tp09", "Tp0T", "Tp01", "Tp05", "Tp0D", "Tp0H", "Tp0L", "Tp0P", "Tp0X", "Tp0b"];
const M2: &[&str] = &["Tp1h", "Tp1t", "Tp1p", "Tp1l", "Tp01", "Tp05", "Tp09", "Tp0D", "Tp0X", "Tp0b", "Tp0f", "Tp0j"];
const M3: &[&str] = &[
    "Te05", "Te0L", "Te0P", "Te0S", "Tf04", "Tf09", "Tf0A", "Tf0B", "Tf0D", "Tf0E", "Tf44", "Tf49", "Tf4A", "Tf4B", "Tf4D", "Tf4E",
];
const M4: &[&str] = &["Te05", "Te0S", "Te09", "Te0H", "Tp01", "Tp05", "Tp09", "Tp0D", "Tp0V", "Tp0Y", "Tp0b", "Tp0e"];
const M5: &[&str] = &[
    "Tp00", "Tp04", "Tp08", "Tp0C", "Tp0G", "Tp0K", "Tp0O", "Tp0R", "Tp0U", "Tp0X", "Tp0a", "Tp0d", "Tp0g", "Tp0j", "Tp0m", "Tp0p",
    "Tp0u", "Tp0y",
];
const M6: &[&str] = &[
    "Tp0j", "Tp0g", "Tp09", "Tp07", "Tp0m", "Tp0L", "Tp0I", "Tp0d", "Tp0E", "Tp0G", "Tp0b", "Tp05", "Te07", "Te08", "Te09", "Te0c",
    "Te0h", "Te0i",
];
const A18_PRO: &[&str] = &["Te05", "Te0S", "Tp05", "Tp0D"];

/// The chip's CPU core keys, as Stats lists them. Not every key exists on
/// every variant (an M3 Pro has only Te05, Te0P and Te0S of the M3 list).
pub fn keys(chip: Chip) -> &'static [&'static str] {
    match chip {
        Chip::M1 => M1,
        Chip::M2 => M2,
        Chip::M3 => M3,
        Chip::M4 => M4,
        Chip::M5 => M5,
        Chip::M6 => M6,
        Chip::A18Pro => A18_PRO,
    }
}

/// The hottest believable reading among `keys`; keys this Mac lacks and
/// nonsense values are skipped. None: none left.
pub fn hottest_core(smc: &mut impl Smc, keys: &[&str]) -> Option<f32> {
    hottest(keys.iter().filter_map(|k| smc.read_f32(k).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fan_control::Smc;
    use std::collections::HashMap;

    /// An SMC holding only float keys.
    struct Floats(HashMap<&'static str, f32>);

    impl Smc for Floats {
        fn read_u8(&mut self, key: &str) -> Result<u8, String> {
            Err(format!("{key}: not here"))
        }
        fn read_f32(&mut self, key: &str) -> Result<f32, String> {
            self.0.get(key).copied().ok_or_else(|| format!("{key}: not here"))
        }
        fn write_u8(&mut self, key: &str, _: u8) -> Result<(), String> {
            Err(format!("{key}: read only"))
        }
        fn write_f32(&mut self, key: &str, _: f32) -> Result<(), String> {
            Err(format!("{key}: read only"))
        }
    }

    fn fake(keys: &[(&'static str, f32)]) -> Floats {
        Floats(keys.iter().copied().collect())
    }

    #[test]
    fn chips_from_the_brand_string() {
        assert_eq!(chip("Apple M3 Pro"), Some(Chip::M3));
        assert_eq!(chip("Apple M1"), Some(Chip::M1));
        assert_eq!(chip("Apple M2 Max"), Some(Chip::M2));
        assert_eq!(chip("Apple M4"), Some(Chip::M4));
        assert_eq!(chip("Apple M5 Pro"), Some(Chip::M5));
        assert_eq!(chip("Apple M6"), Some(Chip::M6));
        assert_eq!(chip("Apple A18 Pro"), Some(Chip::A18Pro));
        for unknown in ["Apple M9", "Apple M10", "Apple A18", "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz", ""] {
            assert_eq!(chip(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn the_key_lists_are_stats_own() {
        assert_eq!(
            keys(Chip::M3),
            ["Te05", "Te0L", "Te0P", "Te0S", "Tf04", "Tf09", "Tf0A", "Tf0B", "Tf0D", "Tf0E", "Tf44", "Tf49", "Tf4A", "Tf4B", "Tf4D", "Tf4E"]
        );
        let lens = [Chip::M1, Chip::M2, Chip::M4, Chip::M5, Chip::M6, Chip::A18Pro].map(|c| keys(c).len());
        assert_eq!(lens, [10, 12, 12, 18, 18, 4]);
    }

    #[test]
    fn hottest_core_skips_missing_and_nonsense() {
        let mut smc = fake(&[("Te05", 56.2), ("Te0P", 57.0), ("Te0S", -9201.1), ("Tf04", 400.0), ("Tf09", 0.0)]);
        assert_eq!(hottest_core(&mut smc, keys(Chip::M3)), Some(57.0));
        assert_eq!(hottest_core(&mut smc, keys(Chip::M1)), None);
        assert_eq!(hottest_core(&mut fake(&[]), keys(Chip::M3)), None);
    }
}
