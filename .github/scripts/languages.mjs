import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const token = process.env.GH_TOKEN;
const output = process.env.OUTPUT ?? "assets/languages.svg";
const limit = Number(process.env.LIMIT ?? 10);
const excluded = new Set(
  (process.env.EXCLUDE_LANGUAGES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

if (!token) throw new Error("GH_TOKEN is required");

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

const REPO_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    nameWithOwner
    isFork
    languages(first: 50, orderBy: { field: SIZE, direction: DESC }) {
      edges { size node { name color } }
    }
  }
`;

async function paginate(fetchPage) {
  const nodes = [];
  let cursor = null;
  do {
    const conn = await fetchPage(cursor);
    nodes.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}

const viewerRepos = await paginate(async (after) =>
  (
    await gql(
      `query($after: String) { viewer { repositories(first: 100, after: $after, isFork: false,
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) { ${REPO_FIELDS} } } }`,
      { after },
    )
  ).viewer.repositories,
);

const orgs = await paginate(async (after) =>
  (
    await gql(
      `query($after: String) { viewer { organizations(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor } nodes { login } } } }`,
      { after },
    )
  ).viewer.organizations,
);

const orgRepos = [];
for (const { login } of orgs) {
  orgRepos.push(
    ...(await paginate(async (after) =>
      (
        await gql(
          `query($login: String!, $after: String) { organization(login: $login) {
            repositories(first: 100, after: $after, isFork: false) { ${REPO_FIELDS} } } }`,
          { login, after },
        )
      ).organization.repositories,
    )),
  );
}

const repos = new Map();
for (const repo of [...viewerRepos, ...orgRepos]) {
  if (!repo.isFork) repos.set(repo.nameWithOwner, repo);
}

const totals = new Map();
let counted = 0;
for (const repo of repos.values()) {
  let has = false;
  for (const { size, node } of repo.languages.edges) {
    if (excluded.has(node.name.toLowerCase())) continue;
    const entry = totals.get(node.name) ?? { name: node.name, color: node.color ?? "#8b949e", size: 0 };
    entry.size += size;
    totals.set(node.name, entry);
    has = true;
  }
  if (has) counted++;
}

const sum = [...totals.values()].reduce((a, b) => a + b.size, 0);
if (!sum) throw new Error("No language data found");

const sorted = [...totals.values()].sort((a, b) => b.size - a.size);
const top = sorted.slice(0, limit);
const rest = sorted.slice(limit).reduce((a, b) => a + b.size, 0);
if (rest > 0) top.push({ name: "Other", color: "#6e7681", size: rest });

const items = top.map((l) => ({ ...l, pct: (l.size / sum) * 100 }));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (p) => (p >= 10 ? p.toFixed(1) : p.toFixed(2)) + "%";

const W = 800;
const PAD = 28;
const BAR_Y = 92;
const BAR_H = 12;
const barW = W - PAD * 2;
const cols = 2;
const rowH = 30;
const listY = BAR_Y + BAR_H + 34;
const rows = Math.ceil(items.length / cols);
const H = listY + rows * rowH + 12;
const colW = barW / cols;

let x = PAD;
const segments = items
  .map((l, i) => {
    const w = i === items.length - 1 ? PAD + barW - x : (l.pct / 100) * barW;
    const seg = `<rect x="${x.toFixed(2)}" y="${BAR_Y}" width="${Math.max(w, 0).toFixed(2)}" height="${BAR_H}" fill="${l.color}"/>`;
    x += w;
    return seg;
  })
  .join("");

const legend = items
  .map((l, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const lx = PAD + col * colW;
    const ly = listY + row * rowH;
    return `<g transform="translate(${lx.toFixed(2)} ${ly})">
    <circle cx="6" cy="0" r="6" fill="${l.color}"/>
    <text x="22" y="5" class="name">${esc(l.name)}</text>
    <text x="${(colW - 24).toFixed(2)}" y="5" class="pct" text-anchor="end">${fmt(l.pct)}</text>
  </g>`;
  })
  .join("\n  ");

const orgCount = orgs.length;
const subtitle = `Across ${counted} repositories · personal${orgCount ? ` + ${orgCount} organization${orgCount > 1 ? "s" : ""}` : ""}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">Most used languages</title>
  <desc id="d">${esc(items.map((l) => `${l.name} ${fmt(l.pct)}`).join(", "))}</desc>
  <style>
    .card { fill: #ffffff; stroke: #d0d7de; }
    .title { font: 600 20px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #00ADB5; }
    .sub { font: 400 13px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #57606a; }
    .name { font: 500 14px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #1f2328; }
    .pct { font: 400 13px ui-monospace, SFMono-Regular, Consolas, monospace; fill: #57606a; }
    @media (prefers-color-scheme: dark) {
      .card { fill: #222831; stroke: #393E46; }
      .sub, .pct { fill: #9aa4ae; }
      .name { fill: #EEEEEE; }
    }
  </style>
  <rect class="card" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12"/>
  <text x="${PAD}" y="44" class="title">Most Used Languages</text>
  <text x="${PAD}" y="68" class="sub">${esc(subtitle)}</text>
  <clipPath id="bar"><rect x="${PAD}" y="${BAR_Y}" width="${barW}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>
  <g clip-path="url(#bar)">${segments}</g>
  ${legend}
</svg>
`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, svg);
console.log(`${counted} repositories, ${totals.size} languages → ${output}`);
console.log(items.map((l) => `${l.name} ${fmt(l.pct)}`).join(" | "));
