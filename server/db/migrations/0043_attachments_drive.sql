DROP INDEX "entries_seq_unique";--> statement-breakpoint
DROP INDEX "gl_entries_active_line";--> statement-breakpoint
DROP INDEX "gl_entries_voucher";--> statement-breakpoint
DROP INDEX "income_records_seq_unique";--> statement-breakpoint
ALTER TABLE `attachments` ALTER COLUMN "data" TO "data" blob;--> statement-breakpoint
CREATE UNIQUE INDEX `entries_seq_unique` ON `entries` (`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `gl_entries_active_line` ON `gl_entries` (`voucher_type`,`voucher_id`,`line_no`) WHERE is_cancelled = 0;--> statement-breakpoint
CREATE INDEX `gl_entries_voucher` ON `gl_entries` (`voucher_type`,`voucher_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `income_records_seq_unique` ON `income_records` (`seq`);--> statement-breakpoint
ALTER TABLE `attachments` ADD `drive_file_id` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `drive_url` text;