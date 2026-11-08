using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;

namespace FishingbotDesktopV2
{
    // Icon set in the Untitled UI style: 24-unit grid, outline strokes, round caps and joins.
    // The path data matches local/icons.js, so the desktop app and the browser hub show the same glyphs.
    internal static class IconSet
    {
        public static readonly Dictionary<string, string> Paths = new Dictionary<string, string>
        {
            { "update", "M 21.00 12.00 L 20.69 14.33 L 19.79 16.50 L 18.36 18.36 L 16.50 19.79 L 14.33 20.69 L 12.00 21.00 L 9.67 20.69 L 7.50 19.79 L 5.64 18.36 L 4.21 16.50 L 3.31 14.33 L 3.00 12.00 L 3.31 9.67 L 4.21 7.50 L 5.64 5.64 L 7.50 4.21 L 9.67 3.31 L 12.00 3.00 L 14.33 3.31 L 16.50 4.21 L 18.36 5.64 L 19.79 7.50 L 20.69 9.67 Z M 12 16 L 12 8 M 8.5 11.5 L 12 8 L 15.5 11.5" },
            { "download", "M 4 14 L 4 19 L 20 19 L 20 14 M 12 4 L 12 15 M 7.5 10.5 L 12 15 L 16.5 10.5" },
            { "refresh", "M 18.93 8 L 19.43 9.04 L 19.78 10.13 L 19.97 11.27 L 19.99 12.42 L 19.85 13.56 L 19.54 14.67 L 19.08 15.72 L 18.47 16.7 L 17.73 17.58 L 16.87 18.35 L 15.91 18.98 L 14.87 19.47 L 13.77 19.8 L 12.63 19.98 L 11.48 19.98 L 10.34 19.83 L 9.23 19.51 L 8.18 19.03 L 7.21 18.41 L 6.34 17.66 L 5.59 16.79 L 4.97 15.82 L 4.49 14.77 L 4.17 13.66 L 4.02 12.52 L 4.02 11.37 L 4.2 10.23 L 4.53 9.13 L 5.02 8.09 L 5.65 7.13 L 6.42 6.27 L 7.3 5.53 L 8.28 4.92 L 9.33 4.46 L 10.44 4.15 L 11.58 4.01 L 12.73 4.03 L 13.87 4.22 L 14.96 4.57 L 16 5.07 M 14.7 1.08 L 16 5.07 L 11.89 5.95" },
            { "settings", "M 18.66 10.21 L 21.09 10.56 L 21.09 13.44 L 18.66 13.79 L 17.98 15.45 L 19.44 17.41 L 17.41 19.44 L 15.45 17.98 L 13.79 18.66 L 13.44 21.09 L 10.56 21.09 L 10.21 18.66 L 8.55 17.98 L 6.59 19.44 L 4.56 17.41 L 6.02 15.45 L 5.34 13.79 L 2.91 13.44 L 2.91 10.56 L 5.34 10.21 L 6.02 8.55 L 4.56 6.59 L 6.59 4.56 L 8.55 6.02 L 10.21 5.34 L 10.56 2.91 L 13.44 2.91 L 13.79 5.34 L 15.45 6.02 L 17.41 4.56 L 19.44 6.59 L 17.98 8.55 Z M 15.1 12 L 14.99 12.8 L 14.68 13.55 L 14.19 14.19 L 13.55 14.68 L 12.8 14.99 L 12 15.1 L 11.2 14.99 L 10.45 14.68 L 9.81 14.19 L 9.32 13.55 L 9.01 12.8 L 8.9 12 L 9.01 11.2 L 9.32 10.45 L 9.81 9.81 L 10.45 9.32 L 11.2 9.01 L 12 8.9 L 12.8 9.01 L 13.55 9.32 L 14.19 9.81 L 14.68 10.45 L 14.99 11.2 Z" },
            { "external", "M 14 4 L 20 4 L 20 10 M 20 4 L 11 13 M 18 14 L 18 20 L 4 20 L 4 6 L 10 6" },
            { "arrow-left", "M 19 12 L 5 12 M 11 6 L 5 12 L 11 18" },
            { "layout", "M 4 4 L 10 4 L 10 10 L 4 10 Z M 14 4 L 20 4 L 20 10 L 14 10 Z M 4 14 L 10 14 L 10 20 L 4 20 Z M 14 14 L 20 14 L 20 20 L 14 20 Z" },
            { "package", "M 12 3 L 20.5 7.5 L 20.5 16.5 L 12 21 L 3.5 16.5 L 3.5 7.5 Z M 3.5 7.5 L 12 12 L 20.5 7.5 M 12 12 L 12 21" },
            { "sliders", "M 3 7 L 21 7 M 3 17 L 21 17 M 11.6 7 L 11.47 7.8 L 11.1 8.53 L 10.53 9.1 L 9.8 9.47 L 9 9.6 L 8.2 9.47 L 7.47 9.1 L 6.9 8.53 L 6.53 7.8 L 6.4 7 L 6.53 6.2 L 6.9 5.47 L 7.47 4.9 L 8.2 4.53 L 9 4.4 L 9.8 4.53 L 10.53 4.9 L 11.1 5.47 L 11.47 6.2 Z M 17.6 17 L 17.47 17.8 L 17.1 18.53 L 16.53 19.1 L 15.8 19.47 L 15 19.6 L 14.2 19.47 L 13.47 19.1 L 12.9 18.53 L 12.53 17.8 L 12.4 17 L 12.53 16.2 L 12.9 15.47 L 13.47 14.9 L 14.2 14.53 L 15 14.4 L 15.8 14.53 L 16.53 14.9 L 17.1 15.47 L 17.47 16.2 Z" },
            { "chat", "M 4 5 L 20 5 L 20 16 L 11 16 L 7 19.5 L 7 16 L 4 16 Z" },
            { "layers", "M 12 3 L 21 8 L 12 13 L 3 8 Z M 3 12.5 L 12 17.5 L 21 12.5 M 3 17 L 12 22 L 21 17" },
            { "user", "M 16 8 L 15.86 9.04 L 15.46 10 L 14.83 10.83 L 14 11.46 L 13.04 11.86 L 12 12 L 10.96 11.86 L 10 11.46 L 9.17 10.83 L 8.54 10 L 8.14 9.04 L 8 8 L 8.14 6.96 L 8.54 6 L 9.17 5.17 L 10 4.54 L 10.96 4.14 L 12 4 L 13.04 4.14 L 14 4.54 L 14.83 5.17 L 15.46 6 L 15.86 6.96 Z M 4.5 21 L 4.56 20.02 L 4.76 19.06 L 5.07 18.13 L 5.5 17.25 L 6.05 16.43 L 6.7 15.7 L 7.43 15.05 L 8.25 14.5 L 9.13 14.07 L 10.06 13.76 L 11.02 13.56 L 12 13.5 L 12.98 13.56 L 13.94 13.76 L 14.87 14.07 L 15.75 14.5 L 16.57 15.05 L 17.3 15.7 L 17.95 16.43 L 18.5 17.25 L 18.93 18.13 L 19.24 19.06 L 19.44 20.02 L 19.5 21" },
            { "video", "M 3 7 L 14 7 L 14 17 L 3 17 Z M 14 11 L 21 7 L 21 17 L 14 13" },
            { "lock", "M 6 11 L 18 11 L 18 20.5 L 6 20.5 Z M 8.5 11 L 8.5 8 L 8.57 7.32 L 8.77 6.66 L 9.09 6.06 L 9.53 5.53 L 10.06 5.09 L 10.66 4.77 L 11.32 4.57 L 12 4.5 L 12.68 4.57 L 13.34 4.77 L 13.94 5.09 L 14.47 5.53 L 14.91 6.06 L 15.23 6.66 L 15.43 7.32 L 15.5 8 L 15.5 11" },
            { "minus", "M 5 12 L 19 12" }
        };

        // Draws one icon inside box. The stroke is in pixels, so it stays crisp at 14 to 20 px.
        public static void Draw(Graphics g, string name, RectangleF box, Color color, float stroke)
        {
            string data;
            if (!Paths.TryGetValue(name, out data)) return;

            float scale = Math.Min(box.Width, box.Height) / 24f;
            float ox = box.X + (box.Width - 24f * scale) / 2f;
            float oy = box.Y + (box.Height - 24f * scale) / 2f;
            string[] tokens = data.Split(' ');

            using (var path = new GraphicsPath())
            {
                PointF current = PointF.Empty;
                PointF start = PointF.Empty;
                for (int i = 0; i < tokens.Length; i++)
                {
                    string cmd = tokens[i];
                    if (cmd == "M" || cmd == "L")
                    {
                        float x = float.Parse(tokens[i + 1], CultureInfo.InvariantCulture) * scale + ox;
                        float y = float.Parse(tokens[i + 2], CultureInfo.InvariantCulture) * scale + oy;
                        i += 2;
                        var point = new PointF(x, y);
                        if (cmd == "M")
                        {
                            path.StartFigure();
                            start = point;
                        }
                        else
                        {
                            path.AddLine(current, point);
                        }
                        current = point;
                    }
                    else if (cmd == "Z")
                    {
                        path.CloseFigure();
                        current = start;
                    }
                }

                var previous = g.SmoothingMode;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var pen = new Pen(color, stroke))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    g.DrawPath(pen, path);
                }
                g.SmoothingMode = previous;
            }
        }
    }
}
