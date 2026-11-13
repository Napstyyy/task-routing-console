/** Initials avatar with a stable per-person hue. */
export function Avatar({ id, name, size = 30 }: { id: number; name: string; size?: number }) {
  const initials = name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  const hue = (id * 67) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, background: `hsl(${hue} 70% 92%)`, color: `hsl(${hue} 45% 32%)` }} aria-hidden>
      {initials}
    </span>
  );
}
