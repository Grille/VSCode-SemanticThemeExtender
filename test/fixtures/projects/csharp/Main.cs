using System;

namespace Fixture;

public class Child : Slotted
{
    public Child(int a) : base(a) { }
}

public class GrandChild : Child
{
    public GrandChild(int a) : base(a) { }
}

[Serializable]
public class Point
{
    public int X;

    [Obsolete]
    public static Point Make() => new Point();
}

public static class Handlers
{
    /// <summary>Deprecated: use something else.</summary>
    public static void handler(Func<int, string> callback) => callback(1);

    public static readonly GrandChild x = new GrandChild(1);
}
