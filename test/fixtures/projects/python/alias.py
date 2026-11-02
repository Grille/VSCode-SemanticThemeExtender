from enum import StrEnum


class Outer:
    class Sockets(StrEnum):
        A = "a"


def f():
    LS = Outer.Sockets
    return LS.A


Top = Outer.Sockets
