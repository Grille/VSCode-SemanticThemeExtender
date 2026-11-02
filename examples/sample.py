"""Sample for trying rules: structs-like classes, slots, dunders, self/cls."""

from dataclasses import dataclass
from enum import Enum
from typing import Generic, NamedTuple, Protocol, TypeVar

T = TypeVar("T")


class Color(Enum):
    RED = 1
    GREEN = 2


class TupleLost(tuple):
    def __new__(cls, iterable):
        return super().__new__(cls, iterable)


class TupleKeept(tuple):
    __slots__ = ()
    def __new__(cls, iterable):
        return super().__new__(cls, iterable)


class Point(NamedTuple):
    x: float
    y: float


class Slotted:
    __slots__ = ("a", "b")

    def __init__(self, a: int, b: int) -> None:
        self.a = a
        self.b = b

    @classmethod
    def make(cls) -> "Slotted":
        return cls(1, 2)


class Shape(Protocol):
    def area(self) -> float: ...


class SlottedLost(Slotted):
    def __init__(self) -> None:
        super().__init__(0, 0)


class SlottedKeept(Slotted):
    __slots__ = ()
    def __init__(self) -> None:
        super().__init__(0, 0)


@dataclass
class Box(Generic[T]):
    """A box holding one value."""

    value: T

    def get(self) -> T:
        b: tuple
        return self.value


print(Slotted.__slots__, Slotted.__name__, Point(1, 2).x, Color.RED)
