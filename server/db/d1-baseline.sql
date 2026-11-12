-- D1（Cloudflare）の DB を空から作るときに1回だけ流す（npm run db:baseline:d1）。
-- 今の server/db/schema.ts の表をまとめて作り、server/db/migrations の 0000〜.sql を適用済みとして記録する。
-- 以後のマイグレーションは npm run db:migrate:d1（wrangler d1 migrations apply）で流す。
-- 作り直すときは npx drizzle-kit export --sql の出力を使う。

CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`data` blob,
	`drive_file_id` text,
	`drive_url` text,
	`created_at` integer NOT NULL
);

CREATE TABLE `budget_bureaus` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`bureau_no` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` real NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `budget_rounds`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `budget_change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`item_number` text DEFAULT '' NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`bureau` text NOT NULL,
	`team` text NOT NULL,
	`kind` text NOT NULL,
	`after` text,
	`before` text,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`direct` integer DEFAULT false NOT NULL,
	`review_comment` text DEFAULT '' NOT NULL,
	`reviewed_at` integer,
	`reviewed_by` text
);

CREATE TABLE `budget_departments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`bureau_id` integer NOT NULL,
	`code` text NOT NULL,
	`name_ja` text DEFAULT '' NOT NULL,
	`sort_order` real NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `budget_rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bureau_id`) REFERENCES `budget_bureaus`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `budget_lines` (
	`key` text PRIMARY KEY NOT NULL,
	`sort_order` integer NOT NULL,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`bureau_no` text DEFAULT '' NOT NULL,
	`bureau` text DEFAULT '' NOT NULL,
	`team` text DEFAULT '' NOT NULL,
	`kan_no` text DEFAULT '' NOT NULL,
	`kan` text DEFAULT '' NOT NULL,
	`kou_no` text DEFAULT '' NOT NULL,
	`kou` text DEFAULT '' NOT NULL,
	`moku` text DEFAULT '' NOT NULL,
	`setsu` text DEFAULT '' NOT NULL,
	`level` text DEFAULT 'none' NOT NULL,
	`label` text NOT NULL,
	`quantity` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`budget_amount` integer NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	`planned_timing` text DEFAULT '' NOT NULL,
	`remark` text DEFAULT '' NOT NULL,
	`imported_at` integer NOT NULL,
	`budget_kind` text DEFAULT '本予算' NOT NULL
);

CREATE TABLE `budget_reference_files` (
	`kind` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`count` integer NOT NULL,
	`total` integer NOT NULL,
	`imported_at` integer NOT NULL,
	`imported_by` text NOT NULL
);

CREATE TABLE `budget_references` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`sort_order` integer NOT NULL,
	`item_number` text DEFAULT '' NOT NULL,
	`bureau` text DEFAULT '' NOT NULL,
	`team` text DEFAULT '' NOT NULL,
	`kan` text DEFAULT '' NOT NULL,
	`kou` text DEFAULT '' NOT NULL,
	`moku` text DEFAULT '' NOT NULL,
	`setsu` text DEFAULT '' NOT NULL,
	`quantity` text DEFAULT '' NOT NULL,
	`unit_price` integer,
	`amount` integer NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`spec` text DEFAULT '' NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	`planned_timing` text DEFAULT '' NOT NULL,
	`remark` text DEFAULT '' NOT NULL,
	`is_new` integer DEFAULT false NOT NULL,
	`pre_execution` integer DEFAULT false NOT NULL
);

CREATE TABLE `budget_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` integer NOT NULL,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`row_id` text,
	`bulk` text,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);

CREATE TABLE `budget_rounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`term` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'collecting' NOT NULL,
	`base_round_id` integer,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`confirmed_at` integer
);

CREATE TABLE `budget_sheet_rows` (
	`sort_order` integer PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`cells` text NOT NULL,
	`line_key` text
);

CREATE TABLE `budget_teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`bureau_id` integer,
	`department_id` integer,
	`bureau_no` text NOT NULL,
	`bureau` text NOT NULL,
	`team` text NOT NULL,
	`name_ja` text DEFAULT '' NOT NULL,
	`person` text DEFAULT '' NOT NULL,
	`sort_order` real NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `budget_rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bureau_id`) REFERENCES `budget_bureaus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `budget_departments`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `cashbook_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`account` text NOT NULL,
	`to_account` text,
	`amount` integer NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);

CREATE TABLE `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);

CREATE TABLE `entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seq` text NOT NULL,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`applicant_email` text NOT NULL,
	`applicant_name` text NOT NULL,
	`department` text NOT NULL,
	`in_charge` text NOT NULL,
	`item_number` text NOT NULL,
	`item_name` text NOT NULL,
	`amount` integer,
	`quantity` text,
	`deadline` text,
	`remark` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`attachment_id` integer,
	`payment_method` text,
	`executed_at` integer,
	`executed_by` text,
	`evidence_checked_at` integer,
	`evidence_checked_by` text,
	`evidence_return_comment` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `entries_seq_unique` ON `entries` (`seq`);
CREATE TABLE `entry_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`line_key` text NOT NULL,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`label` text NOT NULL,
	`quantity` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`budget_amount` integer NOT NULL,
	`actual_quantity` text,
	`actual_vendor` text,
	`actual_amount` integer,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `evidence_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount` integer,
	`date` text,
	`uploaded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);

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

CREATE UNIQUE INDEX `gl_entries_active_line` ON `gl_entries` (`voucher_type`,`voucher_id`,`line_no`) WHERE is_cancelled = 0;
CREATE INDEX `gl_entries_voucher` ON `gl_entries` (`voucher_type`,`voucher_id`);
CREATE TABLE `income_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`income_id` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`kind` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`income_id`) REFERENCES `income_records`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `income_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seq` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`applicant_email` text NOT NULL,
	`applicant_name` text NOT NULL,
	`department` text NOT NULL,
	`in_charge` text NOT NULL,
	`line_key` text,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`item_name` text NOT NULL,
	`budget_amount` integer,
	`amount` integer NOT NULL,
	`received_on` text NOT NULL,
	`payer` text DEFAULT '' NOT NULL,
	`method` text NOT NULL,
	`account` text,
	`remark` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`confirmed_at` integer,
	`confirmed_by` text,
	`created_at` integer NOT NULL
);

CREATE UNIQUE INDEX `income_records_seq_unique` ON `income_records` (`seq`);
CREATE TABLE `issued_item_numbers` (
	`term` text NOT NULL,
	`item_number` text NOT NULL,
	`source` text NOT NULL,
	`reference_number` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`term`, `item_number`)
);

CREATE TABLE `main_budget_items` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`round_id` integer,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`bureau` text NOT NULL,
	`team` text NOT NULL,
	`kan` text DEFAULT '' NOT NULL,
	`kou` text DEFAULT '' NOT NULL,
	`moku` text DEFAULT '' NOT NULL,
	`setsu` text DEFAULT '' NOT NULL,
	`amount` integer NOT NULL,
	`quantity` text DEFAULT '' NOT NULL,
	`unit_price` integer,
	`spec` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`remark` text DEFAULT '' NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	`planned_timing` text DEFAULT '' NOT NULL,
	`is_new` integer DEFAULT false NOT NULL,
	`pre_execution` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort_order` real NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);

CREATE TABLE `main_income_items` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`round_id` integer,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`bureau` text NOT NULL,
	`team` text NOT NULL,
	`kan` text DEFAULT '' NOT NULL,
	`kou` text DEFAULT '' NOT NULL,
	`moku` text DEFAULT '' NOT NULL,
	`setsu` text DEFAULT '' NOT NULL,
	`amount` integer NOT NULL,
	`quantity` text DEFAULT '' NOT NULL,
	`unit_price` integer,
	`spec` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`remark` text DEFAULT '' NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	`planned_timing` text DEFAULT '' NOT NULL,
	`is_new` integer DEFAULT false NOT NULL,
	`pre_execution` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort_order` real NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);

CREATE TABLE `revised_budget_items` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`round_id` integer,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`bureau` text NOT NULL,
	`team` text NOT NULL,
	`kan` text DEFAULT '' NOT NULL,
	`kou` text DEFAULT '' NOT NULL,
	`moku` text DEFAULT '' NOT NULL,
	`setsu` text DEFAULT '' NOT NULL,
	`amount` integer NOT NULL,
	`quantity` text DEFAULT '' NOT NULL,
	`unit_price` integer,
	`spec` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`remark` text DEFAULT '' NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	`planned_timing` text DEFAULT '' NOT NULL,
	`is_new` integer DEFAULT false NOT NULL,
	`pre_execution` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort_order` real NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);

CREATE TABLE `revised_income_items` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`round_id` integer,
	`item_number` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`bureau` text NOT NULL,
	`team` text NOT NULL,
	`kan` text DEFAULT '' NOT NULL,
	`kou` text DEFAULT '' NOT NULL,
	`moku` text DEFAULT '' NOT NULL,
	`setsu` text DEFAULT '' NOT NULL,
	`amount` integer NOT NULL,
	`quantity` text DEFAULT '' NOT NULL,
	`unit_price` integer,
	`spec` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`remark` text DEFAULT '' NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	`planned_timing` text DEFAULT '' NOT NULL,
	`is_new` integer DEFAULT false NOT NULL,
	`pre_execution` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort_order` real NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);

CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	`dm_on_created` integer DEFAULT true NOT NULL,
	`dm_on_executed` integer DEFAULT true NOT NULL,
	`slack_email` text DEFAULT '' NOT NULL,
	`budget_bureau` text DEFAULT '' NOT NULL,
	`budget_team` text DEFAULT '' NOT NULL
);


CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');
INSERT INTO d1_migrations (name) VALUES ('0001_budget.sql');
INSERT INTO d1_migrations (name) VALUES ('0002_budget_hierarchy.sql');
INSERT INTO d1_migrations (name) VALUES ('0003_users.sql');
INSERT INTO d1_migrations (name) VALUES ('0004_users_preregister.sql');
INSERT INTO d1_migrations (name) VALUES ('0005_two_roles.sql');
INSERT INTO d1_migrations (name) VALUES ('0006_actual_amount.sql');
INSERT INTO d1_migrations (name) VALUES ('0007_item_quantity_vendor.sql');
INSERT INTO d1_migrations (name) VALUES ('0008_budget_kind.sql');
INSERT INTO d1_migrations (name) VALUES ('0009_notification_settings.sql');
INSERT INTO d1_migrations (name) VALUES ('0010_evidence_files.sql');
INSERT INTO d1_migrations (name) VALUES ('0011_budget_sheet_rows.sql');
INSERT INTO d1_migrations (name) VALUES ('0012_budget_rounds.sql');
INSERT INTO d1_migrations (name) VALUES ('0013_clear_team_persons.sql');
INSERT INTO d1_migrations (name) VALUES ('0014_budget_changes.sql');
INSERT INTO d1_migrations (name) VALUES ('0015_budget_references.sql');
INSERT INTO d1_migrations (name) VALUES ('0016_budget_db_v2.sql');
INSERT INTO d1_migrations (name) VALUES ('0017_budget_db_v2_data.sql');
INSERT INTO d1_migrations (name) VALUES ('0018_budget_db_v2_drop.sql');
INSERT INTO d1_migrations (name) VALUES ('0019_budget_bureaus.sql');
INSERT INTO d1_migrations (name) VALUES ('0020_budget_bureaus_data.sql');
INSERT INTO d1_migrations (name) VALUES ('0021_team_name_ja.sql');
INSERT INTO d1_migrations (name) VALUES ('0022_team_names_en.sql');
INSERT INTO d1_migrations (name) VALUES ('0023_team_name_sign.sql');
INSERT INTO d1_migrations (name) VALUES ('0024_budget_departments.sql');
INSERT INTO d1_migrations (name) VALUES ('0025_pre_execution_entry.sql');
INSERT INTO d1_migrations (name) VALUES ('0026_team_capitalize.sql');
INSERT INTO d1_migrations (name) VALUES ('0027_team_case_by_role.sql');
INSERT INTO d1_migrations (name) VALUES ('0028_evidence_check.sql');
INSERT INTO d1_migrations (name) VALUES ('0029_income_records.sql');
INSERT INTO d1_migrations (name) VALUES ('0030_cashbook.sql');
INSERT INTO d1_migrations (name) VALUES ('0031_manual_journals.sql');
INSERT INTO d1_migrations (name) VALUES ('0032_issued_item_numbers.sql');
INSERT INTO d1_migrations (name) VALUES ('0033_item_id.sql');
INSERT INTO d1_migrations (name) VALUES ('0034_merge_incomes_into_entries.sql');
INSERT INTO d1_migrations (name) VALUES ('0035_split_incomes_from_entries.sql');
INSERT INTO d1_migrations (name) VALUES ('0036_drop_pre_execution_requests.sql');
INSERT INTO d1_migrations (name) VALUES ('0037_income_budget_items.sql');
INSERT INTO d1_migrations (name) VALUES ('0038_gl_entries.sql');
INSERT INTO d1_migrations (name) VALUES ('0039_accounts_and_periods.sql');
INSERT INTO d1_migrations (name) VALUES ('0040_drop_manual_journals.sql');
INSERT INTO d1_migrations (name) VALUES ('0041_drop_accounts_and_periods.sql');
INSERT INTO d1_migrations (name) VALUES ('0042_move_old_evidence_entries.sql');
INSERT INTO d1_migrations (name) VALUES ('0043_attachments_drive.sql');
