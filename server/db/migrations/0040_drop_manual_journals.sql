INSERT INTO `gl_entries` (`posting_date`, `account`, `account_kind`, `debit`, `credit`, `voucher_type`, `voucher_id`, `voucher_no`, `voucher_subtype`, `line_no`, `remarks`, `bureau`, `team`, `is_cancelled`, `created_by`, `created_at`)
SELECT m.`date`, json_extract(l.`value`, '$.account'), json_extract(l.`value`, '$.kind'), COALESCE(json_extract(l.`value`, '$.debit'), 0), COALESCE(json_extract(l.`value`, '$.credit'), 0), 'manual', m.`id`, '', '', l.`key`, m.`memo`, '', '', 0, m.`created_by`, m.`created_at`
FROM `manual_journals` m, json_each(m.`lines`) l
WHERE NOT EXISTS (SELECT 1 FROM `gl_entries` g WHERE g.`voucher_type` = 'manual' AND g.`voucher_id` = m.`id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `accounts` (`name`, `kind`, `origin`, `created_at`)
SELECT `account`, MIN(`account_kind`), CASE WHEN `account` LIKE '普通預金%' OR `account` = '現金' THEN 'cash' WHEN `account` IN ('前期繰越', '雑収入', '雑費', '予算にない支出', '予算にない収入', '予算前執行') THEN 'system' ELSE 'manual' END, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM `gl_entries` WHERE `voucher_type` = 'manual' GROUP BY `account`;
--> statement-breakpoint
INSERT INTO `counters` (`name`, `value`)
SELECT 'journal', COALESCE(MAX(`v`), 0) FROM (SELECT `id` AS `v` FROM `manual_journals` UNION ALL SELECT `voucher_id` FROM `gl_entries` WHERE `voucher_type` = 'manual')
WHERE true
ON CONFLICT(`name`) DO UPDATE SET `value` = MAX(`value`, excluded.`value`);
--> statement-breakpoint
DROP TABLE `manual_journals`;
