INSERT INTO `plans` (`id`, `max_bookmarks`, `max_history_entries`, `max_devices`, `operation_retention_days`)
VALUES ('admin', -1, -1, -1, 3650)
ON CONFLICT(`id`) DO NOTHING;
