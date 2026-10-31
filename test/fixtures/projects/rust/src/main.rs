mod base;
use base::Shape;

/// Has corners.
pub trait Polygon: Shape {
    fn corners(&self) -> u32;
}

#[derive(Debug, Clone)]
pub struct Point {
    x: f64,
}

impl Shape for Point {
    fn area(&self) -> f64 {
        self.x
    }
}

impl Polygon for Point {
    fn corners(&self) -> u32 {
        0
    }
}

#[deprecated]
pub fn make() -> Point {
    Point { x: 1.0 }
}

fn main() {
    #[allow(deprecated)]
    let p = make();
    let s = base::Slotted { a: 1 };
    println!("{} {} {:?}", p.area(), s.a, p.clone());
}
