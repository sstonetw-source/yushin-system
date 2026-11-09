# GitHub Pages prelaunch release recovery

The sole authorized prelaunch frontend publisher is `.github/workflows/manual-pages-release.yml`.
It runs automatically after a **successful push-triggered** `System regression tests`
run on `main`, checks out that exact commit, rechecks that it is still the latest
`main`, and publishes only the frontend files to GitHub Pages.

## Verification

1. Check the latest `main` SHA and the full main regression run (`regression` must succeed).
2. Check the Pages run's `head_sha` and successful `Publish successfully tested main frontend` job.
3. Read back the deployed `index.html`, `app.js`, and `transaction-rollout-config.js`
   from the Pages origin and compare their bytes with the **same** source commit.
4. Record the actual published commit. A merged PR, green regression, or queued
   Pages run is **not** proof that the site is updated.

## GitHub-owned failure before any job starts

On 2026-11-10 the Pages workflow run
[`42671038139`](https://github.com/sstonetw-source/yushin-system/actions/runs/42671038139)
for `ef8a6e413267320d6127017812963dea271eb91b` failed with **zero jobs**.
The GitHub Actions UI reported `Internal server error` (correlation ID
`bb8ab6e5-def5-49bb-98e3-891cb9a154b4`). GitHub rejected its
`re-run failed jobs` request with `403: This workflow run cannot be retried`.

This is **not** an application regression failure and must not be hidden by
loosening tests or bypassing branch protection. A new, independently reviewed
`main` push (including a documentation-only change) repeats the required full
CI and, if successful, automatically triggers the existing Pages release.
If GitHub still rejects work before it starts, preserve the last verified
deployment and investigate GitHub Actions infrastructure or support using the
correlation ID; do not claim publication.

## Safety boundary

- Never deploy Firebase Hosting, including previews or rollback channels.
- GitHub Pages publication grants **no** permission to deploy Firebase
  Functions, Rules, Indexes, Secrets, or mutate production data.
- Keep unavailable backend-dependent transactions fail-closed. Never re-enable
  a retired browser writer merely because publication or backend readiness failed.
- Production transaction cutover and employee launch remain separately approved
  and require live role, ledger, inventory, and recovery acceptance.
