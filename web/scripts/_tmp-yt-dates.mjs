async function datePublished(id) {
	const r = await fetch(`https://www.youtube.com/watch?v=${id}`);
	const t = await r.text();
	let m = t.match(/"datePublished":"([^"]+)"/);
	if (!m) m = t.match(/datePublished" content="([^"]+)"/);
	return m ? m[1] : null;
}

/** Calendar day in America/Los_Angeles (matches YouTube page meta). */
function toDdMmmYyyy(iso) {
	const d = new Date(iso);
	const fmt = new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
		timeZone: "America/Los_Angeles",
	});
	const parts = fmt.formatToParts(d);
	const day = parts.find((p) => p.type === "day")?.value ?? "";
	const month = parts.find((p) => p.type === "month")?.value ?? "";
	const year = parts.find((p) => p.type === "year")?.value ?? "";
	return `${day} ${month} ${year}`;
}

for (const id of ["kKna5QNcHwE", "iFucU3quDIg"]) {
	const iso = await datePublished(id);
	console.log(id, iso, iso ? toDdMmmYyyy(iso) : "?");
}
