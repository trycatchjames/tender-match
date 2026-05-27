# tender-scrape

Scrapes current AusTender ATM opportunities to Markdown, classifies them against your positioning statement, then helps review medium/good-fit tenders.

## Setup

```sh
npm install
npx playwright install chromium
export OPENAI_API_KEY="..."
```

`OPENAI_API_KEY` is only needed for `npm run classify:tenders` or `npm start`.

Create your local positioning statement:

```sh
mkdir -p src/tender-fit
$EDITOR src/tender-fit/positioning-statement.md
```

Edit `src/tender-fit/positioning-statement.md` to describe what work is a good, medium, or bad fit for you. This file is gitignored.

## Commands

```sh
npm start
```

Runs the full workflow: scrape, classify, then review.

```sh
npm run scrape
```

Scrapes current ATM detail pages into `output/atms/`. Useful options:

```sh
npm run scrape -- --limit 5
npm run scrape -- --page-limit 1
npm run scrape -- --headful
npm run scrape -- --refresh
npm run scrape -- --out output/current-atms
```

```sh
npm run classify:tenders
```

Classifies unclassified files from `output/atms/` into `output/bad-fit/`, `output/medium-fit/`, `output/good-fit/`, or `output/unclassified/`. New medium/good results are copied to `output/new/<fit>/`.

Useful options:

```sh
npm run classify:tenders -- --limit 10
npm run classify:tenders -- --file example.md
npm run classify:tenders -- --model gpt-5.4
npm run classify:tenders -- --positioning path/to/positioning.md
```

```sh
npm run review
```

Reviews `output/new/good-fit/` and `output/new/medium-fit/`; choose `keep`, `discard`, `skip`, or `quit`. Kept tenders move to `output/shortlist/<fit>/`.

Other commands:

```sh
npm run dev
npm run build
npm run typecheck
```

## Notes

The scraper uses a persistent Playwright profile in `.playwright-profile/`. To log in to AusTender for authenticated pages or downloads, run:

```sh
npm run scrape -- --headful --limit 1
```

Generated files live under `dist/`, `.cache/`, `.playwright-profile/`, and `output/`; these are ignored except for placeholder `.gitignore` files.
