from dataclasses import dataclass
from typing import Callable

from base import Slotted


class Child(Slotted):
    pass


class GrandChild(Child):
    pass


class Keep(Slotted):
    __slots__ = ()


@dataclass
class Point:
    x: int

    @staticmethod
    def make() -> "Point":
        return Point(0)


def handler(callback: Callable[[int], str]) -> None:
    """Deprecated: use something else."""
    callback(1)


x = GrandChild(1)
