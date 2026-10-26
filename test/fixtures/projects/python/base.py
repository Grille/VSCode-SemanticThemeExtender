class Slotted:
    """A class with slots. @struct"""

    __slots__ = ("a",)

    def __init__(self, a: int) -> None:
        self.a = a
