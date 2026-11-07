CREATE TABLE `gl_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`posting_date` text NOT NULL,
	`account` text NOT NULL,
	`account_kind` text NOT NULL,
	`debit` integer DEFAULT 0 NOT NULL,
	`credit` integer DEFAULT 0 NOT NULL,
	`voucher_type` text NOT NULL,
	`voucher_id` integer NOT NULL,
	`voucher_no` text DEFAULT '' NOT NULL,
	`voucher_subtype` text DEFAULT '' NOT NULL,
	`line_no` integer NOT NULL,
	`remarks` text DEFAULT '' NOT NULL,
	`bureau` text DEFAULT '' NOT NULL,
	`team` text DEFAULT '' NOT NULL,
	`is_cancelled` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gl_entries_active_line` ON `gl_entries` (`voucher_type`,`voucher_id`,`line_no`) WHERE is_cancelled = 0;--> statement-breakpoint
CREATE INDEX `gl_entries_voucher` ON `gl_entries` (`voucher_type`,`voucher_id`);