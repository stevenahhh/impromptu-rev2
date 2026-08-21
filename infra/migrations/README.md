# Migration number reservations

Migration filenames are append-only and globally coordinated per database directory. The current
private sequence ends at `0007_embedding_dimension.sql`; the projection sequence ends at
`0005_gateway_state.sql`.

The next private numbers are reserved for the parallel 48-hour feature tracks:

| Filename | Owner |
| --- | --- |
| `private/0008_deck_retrieval_hybrid.sql` | retrieval owner |
| `private/0009_session_reports.sql` | report owner |

No new projection migration is allocated for these tracks. Other owners must not add a private
`0008` or `0009`, and must not create a projection migration for this work.
