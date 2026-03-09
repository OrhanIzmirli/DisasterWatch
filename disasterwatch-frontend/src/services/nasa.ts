export async function fetchNasaDisasters() {
  const res = await fetch("/api/disasters/nasa", {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error("NASA fetch failed");
  }

  return res.json();
}
