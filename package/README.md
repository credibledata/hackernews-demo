# hacker-news

A Malloy semantic model over a curated slice of the public Hacker News dataset.

- **`stories`** — submissions (Ask HN, Show HN, Job, Link). Dimensions for domain,
  category, author, score, and posting time; measures for counts and average
  score/comments; views for top domains, best time to post, category and score
  distributions, and a `hn_overview` dashboard.
- **`comments`** — one row per comment, joined to the story at the root of its
  thread (`root_story_id`). Views for top commenters, comment volume by hour, and
  average comment length by story category.

Times are UTC; scores are point-in-time snapshots. Built by `prep/build-data.mjs`.
