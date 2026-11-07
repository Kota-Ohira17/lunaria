CREATE TABLE `accounting_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `accounts` (`name`, `kind`, `origin`, `created_at`) SELECT `account`, MIN(`account_kind`), CASE WHEN `account` LIKE '普通預金%' OR `account` = '現金' THEN 'cash' WHEN `account` IN ('前期繰越', '雑収入', '雑費', '予算にない支出', '予算にない収入', '予算前執行') THEN 'system' WHEN MAX(`voucher_type` = 'manual') = 1 AND MAX(`voucher_type` <> 'manual') = 0 THEN 'manual' ELSE 'budget' END, CAST(strftime('%s','now') AS INTEGER) * 1000 FROM `gl_entries` GROUP BY `account`;
