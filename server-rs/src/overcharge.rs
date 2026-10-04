//! Port of server/src/overcharge.ts: snapshot rate per player in 2 Hz steps
//! (20 -> 10) driven by a load score.

use crate::constants::TICK_RATE;

const LOOP_TARGET_MS: f64 = 50.0;
const ENTER_AT: f64 = 0.75;
const ENTER_SEC: u32 = 5;
const EXIT_BELOW: f64 = 0.65;
const LOOP_CALM: f64 = 0.5;
const EXIT_SEC: u32 = 10;
const STEP_HZ: u32 = 2;
const MIN_HZ: u32 = 10;
const MAX_HZ: u32 = TICK_RATE;

pub struct Overcharge {
    pub rate: u32,
    pub score: f64,
    egress_budget_mbps: Option<f64>,
    /// Cores the server may use (1 for a single-threaded runtime).
    cpu_budget: f64,
    loop_p99: Vec<f64>,
    hot: u32,
    calm: u32,
}

impl Overcharge {
    pub fn new(egress_budget_mbps: Option<f64>, cpu_budget: f64) -> Overcharge {
        Overcharge { rate: MAX_HZ, score: 0.0, egress_budget_mbps, cpu_budget, loop_p99: Vec::new(), hot: 0, calm: 0 }
    }

    /// Feed one second of load; returns the new rate when it changed.
    pub fn observe(&mut self, loop_p99_ms: f64, cpu: f64, egress_mbps: f64) -> Option<u32> {
        self.loop_p99.push(loop_p99_ms);
        if self.loop_p99.len() > 5 {
            self.loop_p99.remove(0);
        }
        let mut sorted = self.loop_p99.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let loop_part = sorted[sorted.len() / 2] / LOOP_TARGET_MS;
        let cpu_part = cpu / self.cpu_budget;
        let egress_part = self.egress_budget_mbps.map_or(0.0, |b| egress_mbps / b);
        self.score = loop_part.max(cpu_part).max(egress_part);

        if self.score >= ENTER_AT {
            self.hot += 1;
            self.calm = 0;
        } else {
            self.hot = 0;
            let up = (self.rate + STEP_HZ) as f64 / self.rate as f64;
            let room_to_climb =
                self.rate < MAX_HZ && cpu_part * up < EXIT_BELOW && egress_part * up < EXIT_BELOW && loop_part < LOOP_CALM;
            self.calm = if room_to_climb { self.calm + 1 } else { 0 };
        }
        if self.hot >= ENTER_SEC && self.rate > MIN_HZ {
            return Some(self.set((self.rate - STEP_HZ).max(MIN_HZ)));
        }
        if self.calm >= EXIT_SEC {
            return Some(self.set((self.rate + STEP_HZ).min(MAX_HZ)));
        }
        None
    }

    fn set(&mut self, rate: u32) -> u32 {
        self.rate = rate;
        self.hot = 0;
        self.calm = 0;
        rate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_down_under_load_and_back_up_when_calm() {
        let mut o = Overcharge::new(None, 1.0);
        let mut changes = Vec::new();
        for _ in 0..30 {
            changes.extend(o.observe(5.0, 0.9, 0.0));
        }
        assert_eq!(changes, [18, 16, 14, 12, 10]);
        changes.clear();
        for _ in 0..60 {
            changes.extend(o.observe(5.0, 0.2, 0.0));
        }
        assert_eq!(changes, [12, 14, 16, 18, 20]);
    }

    #[test]
    fn predicts_before_climbing() {
        let mut o = Overcharge::new(Some(1_000.0), 1.0);
        for _ in 0..120 {
            let egress = 40.0 * o.rate as f64;
            o.observe(5.0, 0.1, egress);
        }
        assert_eq!(o.rate, 18);
    }
}
