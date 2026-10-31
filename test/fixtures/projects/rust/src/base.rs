/// A shape. marker
pub trait Shape {
    fn area(&self) -> f64;
}

pub struct Slotted {
    pub a: i32,
}
