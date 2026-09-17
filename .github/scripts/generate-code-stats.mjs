import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.PROFILE_USERNAME || "aymenmerabta5";
const token = process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": `${username}-profile-metrics`,
  "X-GitHub-Api-Version": "2022-11-28",
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function github(
  path,
  { attempts = 8, allowPending = false } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`https://api.github.com${path}`, { headers });

    if (response.status === 202) {
      if (attempt === attempts) {
        if (allowPending) {
          console.warn(`Skipping statistics that GitHub is still computing: ${path}`);
          return null;
        }

        throw new Error(`GitHub is still computing statistics for ${path}`);
      }

      await sleep(Math.min(3_000 * attempt, 15_000));
      continue;
    }

    if (response.status === 204) {
      return [];
    }

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`${response.status} ${path}: ${message}`);
    }

    return response.json();
  }

  throw new Error(`Unable to load ${path}`);
}

async function inBatches(items, batchSize, task) {
  const results = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    results.push(...(await Promise.all(batch.map(task))));
  }

  return results;
}

const repositories = await github(
  `/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&per_page=100`,
);

const originalRepositories = repositories.filter(
  (repository) =>
    !repository.fork &&
    !repository.archived &&
    repository.name.toLowerCase() !== username.toLowerCase(),
);

const repositoryStats = await inBatches(
  originalRepositories,
  4,
  async (repository) => {
    const contributors = await github(
      `/repos/${repository.full_name}/stats/contributors`,
      {
        attempts: 3,
        allowPending: true,
      },
    );

    if (!contributors) {
      return {
        name: repository.name,
        additions: 0,
        deletions: 0,
        commits: 0,
        ready: false,
      };
    }

    const contribution = contributors.find(
      (entry) => entry.author?.login?.toLowerCase() === username.toLowerCase(),
    );

    if (!contribution) {
      return {
        name: repository.name,
        additions: 0,
        deletions: 0,
        commits: 0,
        ready: true,
      };
    }

    return contribution.weeks.reduce(
      (totals, week) => ({
        name: repository.name,
        additions: totals.additions + week.a,
        deletions: totals.deletions + week.d,
        commits: totals.commits + week.c,
        ready: true,
      }),
      {
        name: repository.name,
        additions: 0,
        deletions: 0,
        commits: 0,
        ready: true,
      },
    );
  },
);

const readyRepositories = repositoryStats.filter((repository) => repository.ready);
const pendingRepositories = repositoryStats.filter(
  (repository) => !repository.ready,
);

if (pendingRepositories.length > 0) {
  throw new Error(
    `Refusing to publish partial statistics while GitHub is computing: ${pendingRepositories
      .map((repository) => repository.name)
      .join(", ")}`,
  );
}

const activeRepositories = repositoryStats.filter(
  (repository) =>
    repository.ready &&
    (repository.additions > 0 || repository.deletions > 0),
);

const totals = activeRepositories.reduce(
  (result, repository) => ({
    additions: result.additions + repository.additions,
    deletions: result.deletions + repository.deletions,
    commits: result.commits + repository.commits,
  }),
  { additions: 0, deletions: 0, commits: 0 },
);

const topRepositories = [...activeRepositories]
  .sort(
    (left, right) =>
      right.additions + right.deletions - (left.additions + left.deletions),
  )
  .slice(0, 5);

const maxChanges = Math.max(
  ...topRepositories.map(
    (repository) => repository.additions + repository.deletions,
  ),
  1,
);

const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value);
const signedNumber = (value) =>
  `${value >= 0 ? "+" : "−"}${formatNumber(Math.abs(value))}`;
const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const shorten = (value, length = 30) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

const updated = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Africa/Algiers",
}).format(new Date());

const cards = [
  {
    label: "LINES ADDED",
    value: `+${formatNumber(totals.additions)}`,
    color: "#34D399",
    note: "public default branches",
  },
  {
    label: "LINES REMOVED",
    value: `−${formatNumber(totals.deletions)}`,
    color: "#FB7185",
    note: "refactors included",
  },
  {
    label: "NET CHANGE",
    value: signedNumber(totals.additions - totals.deletions),
    color: "#60A5FA",
    note: "added minus removed",
  },
  {
    label: "COMMITS SCANNED",
    value: formatNumber(totals.commits),
    color: "#22D3EE",
    note: `${activeRepositories.length} repositories with activity`,
  },
];

const cardMarkup = cards
  .map((card, index) => {
    const x = 40 + index * 260;
    return `
      <g transform="translate(${x} 92)">
        <rect width="240" height="112" rx="18" fill="#0F1F38" stroke="#334155"/>
        <text x="20" y="29" class="label">${card.label}</text>
        <text x="20" y="70" class="value" fill="${card.color}">${escapeXml(card.value)}</text>
        <text x="20" y="94" class="note">${escapeXml(card.note)}</text>
      </g>`;
  })
  .join("");

const rowMarkup = topRepositories
  .map((repository, index) => {
    const y = 270 + index * 44;
    const changes = repository.additions + repository.deletions;
    const width = Math.max(8, Math.round((changes / maxChanges) * 510));
    const addedWidth = Math.round(width * (repository.additions / changes));
    const deletedWidth = Math.max(0, width - addedWidth);

    return `
      <g transform="translate(40 ${y})">
        <text x="0" y="20" class="repo">${escapeXml(shorten(repository.name))}</text>
        <rect x="250" y="5" width="510" height="18" rx="9" fill="#1E293B"/>
        <rect x="250" y="5" width="${addedWidth}" height="18" rx="9" fill="#34D399"/>
        ${deletedWidth > 0 ? `<rect x="${250 + addedWidth}" y="5" width="${deletedWidth}" height="18" rx="9" fill="#FB7185"/>` : ""}
        <text x="790" y="20" class="changes">+${formatNumber(repository.additions)}  −${formatNumber(repository.deletions)}</text>
      </g>`;
  })
  .join("");

const svg = `<svg width="1080" height="535" viewBox="0 0 1080 535" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(username)} public code activity</title>
  <desc id="description">GitHub contributor statistics for lines added, lines removed, commits, and the most active original public repositories.</desc>
  <defs>
    <linearGradient id="background" x1="45" y1="20" x2="1050" y2="530" gradientUnits="userSpaceOnUse">
      <stop stop-color="#08111F"/>
      <stop offset="0.55" stop-color="#0F1F38"/>
      <stop offset="1" stop-color="#082F49"/>
    </linearGradient>
    <linearGradient id="accent" x1="40" y1="0" x2="1040" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#60A5FA"/>
      <stop offset="0.5" stop-color="#22D3EE"/>
      <stop offset="1" stop-color="#34D399"/>
    </linearGradient>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      .heading { fill: #F8FAFC; font-size: 25px; font-weight: 700; }
      .updated { fill: #94A3B8; font-size: 13px; font-weight: 500; }
      .label { fill: #94A3B8; font-size: 12px; font-weight: 700; letter-spacing: 1.3px; }
      .value { font-size: 28px; font-weight: 750; }
      .note { fill: #94A3B8; font-size: 12px; }
      .section { fill: #CBD5E1; font-size: 13px; font-weight: 700; letter-spacing: 1.2px; }
      .repo { fill: #E2E8F0; font-size: 14px; font-weight: 600; }
      .changes { fill: #CBD5E1; font-family: "SFMono-Regular", Consolas, monospace; font-size: 13px; font-weight: 600; }
      .footnote { fill: #64748B; font-size: 11px; }
    </style>
  </defs>
  <rect x="1" y="1" width="1078" height="533" rx="24" fill="url(#background)" stroke="#334155" stroke-width="2"/>
  <rect x="40" y="28" width="5" height="34" rx="2.5" fill="url(#accent)"/>
  <text x="60" y="51" class="heading">Public code activity</text>
  <text x="1040" y="49" text-anchor="end" class="updated">Updated ${escapeXml(updated)}</text>
  ${cardMarkup}
  <text x="40" y="242" class="section">MOST CODE CHANGED BY REPOSITORY</text>
  <circle cx="842" cy="238" r="5" fill="#34D399"/>
  <text x="854" y="242" class="updated">Added</text>
  <circle cx="920" cy="238" r="5" fill="#FB7185"/>
  <text x="932" y="242" class="updated">Removed</text>
  ${rowMarkup}
  <line x1="40" y1="496" x2="1040" y2="496" stroke="#334155"/>
  <text x="40" y="518" class="footnote">GitHub contributor statistics · ${readyRepositories.length} public repositories scanned · Default branches · Generated or vendored code may be included</text>
</svg>
`;

await mkdir("assets", { recursive: true });
await writeFile("assets/code-stats.svg", svg, "utf8");

console.log(
  `Generated public code statistics for ${activeRepositories.length} repositories: ` +
    `${formatNumber(totals.additions)} additions, ` +
    `${formatNumber(totals.deletions)} deletions, ` +
    `${formatNumber(totals.commits)} commits.`,
);
