//! The world's shape (shared/src/space.ts) and the area-of-interest grid
//! (shared/src/aoi.ts).

use crate::constants::*;
use rand::RngExt;
use std::sync::OnceLock;

/// Allowance for positions rounded to the wire grid.
const EPSILON: f64 = 0.5;
/// Constrained positions stay this far inside the limits.
const MARGIN: f64 = 1.0;

/// Whether a player may be at (x, y): outside the sun, inside the world. Squared
/// distances throughout: glibc's hypot took a third of the server's time.
pub fn can_be_at(x: f64, y: f64) -> bool {
    if !x.is_finite() || !y.is_finite() {
        return false;
    }
    let (dx, dy) = (x - WORLD_CENTER.0, y - WORLD_CENTER.1);
    let r2 = dx * dx + dy * dy;
    r2 >= (SUN_RADIUS - EPSILON).powi(2) && r2 <= (WORLD_RADIUS + EPSILON).powi(2)
}

pub fn constrain(x: f64, y: f64) -> (f64, f64) {
    let dx = x - WORLD_CENTER.0;
    let dy = y - WORLD_CENTER.1;
    let r = dx.hypot(dy);
    let limit = if r > WORLD_RADIUS - MARGIN {
        WORLD_RADIUS - MARGIN
    } else if r < SUN_RADIUS + MARGIN {
        SUN_RADIUS + MARGIN
    } else {
        return (x, y);
    };
    let (ux, uy) = if r == 0.0 { (1.0, 0.0) } else { (dx / r, dy / r) };
    (WORLD_CENTER.0 + ux * limit, WORLD_CENTER.1 + uy * limit)
}

/// Near a random player already in the room, or on a ring around the sun.
pub fn spawn_point(others: &[(f64, f64)]) -> (f64, f64) {
    let mut rng = rand::rng();
    let angle = rng.random::<f64>() * std::f64::consts::TAU;
    if !others.is_empty() {
        let near = others[rng.random_range(0..others.len())];
        let d = SPAWN_NEAR.0 + rng.random::<f64>() * (SPAWN_NEAR.1 - SPAWN_NEAR.0);
        return constrain(near.0 + angle.cos() * d, near.1 + angle.sin() * d);
    }
    let d = SPAWN_RING.0 + rng.random::<f64>() * (SPAWN_RING.1 - SPAWN_RING.0);
    (WORLD_CENTER.0 + angle.cos() * d, WORLD_CENTER.1 + angle.sin() * d)
}

// ------------------------------------------------------------ area of interest

const ROW: u16 = 64;
const ROWS: u16 = 32;

pub fn cell_of(x: f64, y: f64) -> u16 {
    let cx = ((x / AOI_CELL).floor().max(0.0) as u16).min(ROW - 1);
    let cy = ((y / AOI_CELL).floor().max(0.0) as u16).min(ROWS - 1);
    cy * ROW + cx
}

fn center(cell: u16) -> (f64, f64) {
    (((cell % ROW) as f64 + 0.5) * AOI_CELL, ((cell / ROW) as f64 + 0.5) * AOI_CELL)
}

/// From a cell's center: AOI_RADIUS plus the farthest a viewer can be inside the cell.
pub const VIEW_REACH: f64 = AOI_RADIUS + AOI_CELL * std::f64::consts::FRAC_1_SQRT_2;

const REACH_SQ: f64 = VIEW_REACH * VIEW_REACH;
const MEET: f64 = VIEW_REACH + AOI_CELL * std::f64::consts::FRAC_1_SQRT_2;

/// Whether a player at (x, y) is in view of the viewers of `cell`.
pub fn in_view(x: f64, y: f64, cell: u16) -> bool {
    let c = center(cell);
    let (dx, dy) = (x - c.0, y - c.1);
    dx * dx + dy * dy <= REACH_SQ
}

/// Cheap pre-check: whether any point of `other` can be in view of `cell`.
pub fn cells_meet(cell: u16, other: u16) -> bool {
    let a = center(cell);
    let b = center(other);
    let (dx, dy) = (a.0 - b.0, a.1 - b.1);
    dx * dx + dy * dy <= MEET * MEET
}

/// Whether every point of `other` is in view of `cell` (its farthest corner is).
pub fn cell_fully_in_view(other: u16, cell: u16) -> bool {
    let c = center(cell);
    let o = center(other);
    let dx = (o.0 - c.0).abs() + AOI_CELL / 2.0;
    let dy = (o.1 - c.1).abs() + AOI_CELL / 2.0;
    dx * dx + dy * dy <= REACH_SQ
}

/// Every cell with a point possibly in view of `cell` (itself included).
pub fn cells_in_view(cell: u16) -> &'static [u16] {
    static TABLE: OnceLock<Vec<Vec<u16>>> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        (0..ROW * ROWS)
            .map(|c| {
                let span = ((VIEW_REACH + AOI_CELL) / AOI_CELL).ceil() as i32;
                let (cx, cy) = ((c % ROW) as i32, (c / ROW) as i32);
                let mut list = Vec::new();
                for y in (cy - span).max(0)..=(cy + span).min(ROWS as i32 - 1) {
                    for x in (cx - span).max(0)..=(cx + span).min(ROW as i32 - 1) {
                        let other = (y as u16) * ROW + x as u16;
                        if cells_meet(c, other) {
                            list.push(other);
                        }
                    }
                }
                list
            })
            .collect()
    });
    &table[cell as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everyone_within_the_radius_is_in_view_of_the_viewers_cell() {
        let mut rng = rand::rng();
        for _ in 0..5_000 {
            let (vx, vy) = (rng.random_range(500.0..9_500.0), rng.random_range(500.0..9_500.0));
            let a = rng.random::<f64>() * std::f64::consts::TAU;
            let d = rng.random::<f64>() * AOI_RADIUS;
            let (px, py) = (vx + a.cos() * d, vy + a.sin() * d);
            if !can_be_at(vx, vy) || !can_be_at(px, py) {
                continue;
            }
            let cell = cell_of(vx, vy);
            assert!(in_view(px, py, cell));
            assert!(cells_in_view(cell).contains(&cell_of(px, py)));
        }
        assert!(!in_view(9_000.0, 9_000.0, cell_of(1_000.0, 1_000.0)));
    }

    #[test]
    fn a_cell_fully_in_view_has_every_point_in_view() {
        let viewer = cell_of(5_000.0, 5_000.0);
        for &other in cells_in_view(viewer) {
            if !cell_fully_in_view(other, viewer) {
                continue;
            }
            let (ox, oy) = ((other % 64) as f64 * AOI_CELL, (other / 64) as f64 * AOI_CELL);
            for (fx, fy) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
                assert!(in_view(ox + fx * AOI_CELL, oy + fy * AOI_CELL, viewer));
            }
        }
    }

    #[test]
    fn spawn_and_constrain_stay_in_the_world() {
        for _ in 0..1_000 {
            let (x, y) = spawn_point(&[(5_000.0, 5_150.0)]);
            assert!(can_be_at(x, y));
        }
        let (x, y) = constrain(5_000.0, 5_000.0);
        assert!(can_be_at(x, y));
    }
}
