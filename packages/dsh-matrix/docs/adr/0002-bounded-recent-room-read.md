# Bounded recent room read

The active Companion receives a read-only `matrix_read_recent_messages` capability that reads up to the most recent 1–50 ordinary text records from the allowed room, including the Matrix connection's own prior messages. It retrieves server history rather than relying only on a restarted client's local timeline, remains character-bounded and untrusted, and never creates or automatically starts a Companion turn.
