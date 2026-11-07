-- 以前の証憑提出フォームの申請（kind が evidence）を、立替の執行依頼に移す。添付は台帳の証憑（領収書）として付け直す
INSERT INTO `evidence_files` (`entry_id`, `attachment_id`, `kind`, `amount`, `date`, `uploaded_by`, `created_at`)
SELECT `id`, `attachment_id`, '領収書', `amount`, CASE WHEN `deadline` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN substr(`deadline`, 1, 10) ELSE NULL END, `applicant_email`, `created_at`
FROM `entries` WHERE `kind` = 'evidence' AND `attachment_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `entries` SET `kind` = 'execution', `type` = '立替', `attachment_id` = NULL, `payment_method` = CASE WHEN `status` = 'done' THEN COALESCE(`payment_method`, '立替') ELSE NULL END
WHERE `kind` = 'evidence';
