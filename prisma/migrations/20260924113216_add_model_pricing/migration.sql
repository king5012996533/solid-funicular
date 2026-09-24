-- DropForeignKey
ALTER TABLE `agent_process_sections` DROP FOREIGN KEY `fk_agent_process_sections_run_id`;

-- DropForeignKey
ALTER TABLE `agent_run_steps` DROP FOREIGN KEY `fk_agent_run_steps_run_id`;

-- DropForeignKey
ALTER TABLE `agent_runs` DROP FOREIGN KEY `fk_agent_runs_generation_record_id`;

-- DropForeignKey
ALTER TABLE `agent_runs` DROP FOREIGN KEY `fk_agent_runs_user_id`;

-- DropForeignKey
ALTER TABLE `ai_models` DROP FOREIGN KEY `fk_ai_models_provider_id`;

-- DropForeignKey
ALTER TABLE `ai_provider_configs` DROP FOREIGN KEY `fk_ai_provider_configs_user_id`;

-- DropForeignKey
ALTER TABLE `ai_provider_custom_models` DROP FOREIGN KEY `fk_ai_provider_custom_models_config_id`;

-- DropForeignKey
ALTER TABLE `ai_skill_dependencies` DROP FOREIGN KEY `fk_ai_skill_dependencies_dependency_skill_id`;

-- DropForeignKey
ALTER TABLE `ai_skill_dependencies` DROP FOREIGN KEY `fk_ai_skill_dependencies_skill_id`;

-- DropForeignKey
ALTER TABLE `ai_skill_plan_templates` DROP FOREIGN KEY `fk_ai_skill_plan_templates_skill_id`;

-- DropForeignKey
ALTER TABLE `ai_skill_prompt_templates` DROP FOREIGN KEY `fk_ai_skill_prompt_templates_skill_id`;

-- DropForeignKey
ALTER TABLE `ai_skill_stage_templates` DROP FOREIGN KEY `fk_ai_skill_stage_templates_skill_id`;

-- DropForeignKey
ALTER TABLE `ai_skill_workflow_templates` DROP FOREIGN KEY `fk_ai_skill_workflow_templates_skill_id`;

-- DropForeignKey
ALTER TABLE `ai_skills` DROP FOREIGN KEY `fk_ai_skills_provider_id`;

-- DropForeignKey
ALTER TABLE `app_sessions` DROP FOREIGN KEY `fk_app_sessions_user_id`;

-- DropForeignKey
ALTER TABLE `app_user_auth_identities` DROP FOREIGN KEY `fk_app_user_auth_identities_method_type`;

-- DropForeignKey
ALTER TABLE `app_user_auth_identities` DROP FOREIGN KEY `fk_app_user_auth_identities_user_id`;

-- DropForeignKey
ALTER TABLE `asset_favorites` DROP FOREIGN KEY `fk_asset_favorites_asset_id`;

-- DropForeignKey
ALTER TABLE `asset_favorites` DROP FOREIGN KEY `fk_asset_favorites_user_id`;

-- DropForeignKey
ALTER TABLE `asset_items` DROP FOREIGN KEY `fk_asset_items_generation_output_id`;

-- DropForeignKey
ALTER TABLE `asset_items` DROP FOREIGN KEY `fk_asset_items_generation_record_id`;

-- DropForeignKey
ALTER TABLE `asset_items` DROP FOREIGN KEY `fk_asset_items_user_id`;

-- DropForeignKey
ALTER TABLE `auth_method_configs` DROP FOREIGN KEY `fk_auth_method_configs_user_id`;

-- DropForeignKey
ALTER TABLE `auth_verification_codes` DROP FOREIGN KEY `fk_auth_verification_codes_user_id`;

-- DropForeignKey
ALTER TABLE `generation_outputs` DROP FOREIGN KEY `fk_generation_outputs_record_id`;

-- DropForeignKey
ALTER TABLE `generation_records` DROP FOREIGN KEY `fk_generation_records_provider_config_id`;

-- DropForeignKey
ALTER TABLE `generation_records` DROP FOREIGN KEY `fk_generation_records_session_id`;

-- DropForeignKey
ALTER TABLE `generation_records` DROP FOREIGN KEY `fk_generation_records_user_id`;

-- DropForeignKey
ALTER TABLE `generation_sessions` DROP FOREIGN KEY `fk_generation_sessions_user_id`;

-- DropForeignKey
ALTER TABLE `object_storage_configs` DROP FOREIGN KEY `fk_object_storage_configs_user_id`;

-- DropForeignKey
ALTER TABLE `workflow_definition_versions` DROP FOREIGN KEY `fk_workflow_definition_versions_created_by`;

-- DropForeignKey
ALTER TABLE `workflow_definition_versions` DROP FOREIGN KEY `fk_workflow_definition_versions_workflow_id`;

-- DropForeignKey
ALTER TABLE `workflow_definitions` DROP FOREIGN KEY `fk_workflow_definitions_current_version_id`;

-- DropForeignKey
ALTER TABLE `workflow_definitions` DROP FOREIGN KEY `fk_workflow_definitions_user_id`;

-- AlterTable
ALTER TABLE `agent_process_sections` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `agent_run_steps` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `agent_runs` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_models` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_provider_configs` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_provider_custom_models` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_providers` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_skill_plan_templates` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_skill_prompt_templates` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_skill_stage_templates` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_skill_workflow_templates` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `ai_skills` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `app_sessions` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `app_user_auth_identities` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `app_users` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `asset_items` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `auth_method_configs` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `auth_verification_codes` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `generation_outputs` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `generation_records` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `generation_sessions` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `object_storage_configs` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `system_settings` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `workflow_definition_versions` ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `workflow_definitions` ALTER COLUMN `updated_at` DROP DEFAULT;

-- CreateTable
CREATE TABLE `model_pricing` (
    `id` VARCHAR(36) NOT NULL,
    `model_id` VARCHAR(36) NOT NULL,
    `type` ENUM('CHAT', 'IMAGE', 'VIDEO') NOT NULL,
    `price_json` JSON NOT NULL,
    `using_draft` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uk_model_pricing_model`(`model_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_verification_codes` ADD CONSTRAINT `auth_verification_codes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_method_configs` ADD CONSTRAINT `auth_method_configs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_user_auth_identities` ADD CONSTRAINT `app_user_auth_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_user_auth_identities` ADD CONSTRAINT `app_user_auth_identities_method_type_fkey` FOREIGN KEY (`method_type`) REFERENCES `auth_method_configs`(`method_type`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_sessions` ADD CONSTRAINT `app_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_provider_configs` ADD CONSTRAINT `ai_provider_configs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_provider_custom_models` ADD CONSTRAINT `ai_provider_custom_models_provider_config_id_fkey` FOREIGN KEY (`provider_config_id`) REFERENCES `ai_provider_configs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_models` ADD CONSTRAINT `ai_models_provider_id_fkey` FOREIGN KEY (`provider_id`) REFERENCES `ai_providers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `model_pricing` ADD CONSTRAINT `model_pricing_model_id_fkey` FOREIGN KEY (`model_id`) REFERENCES `ai_models`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_skills` ADD CONSTRAINT `ai_skills_provider_id_fkey` FOREIGN KEY (`provider_id`) REFERENCES `ai_providers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_skill_dependencies` ADD CONSTRAINT `ai_skill_dependencies_skill_id_fkey` FOREIGN KEY (`skill_id`) REFERENCES `ai_skills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_skill_dependencies` ADD CONSTRAINT `ai_skill_dependencies_dependency_skill_id_fkey` FOREIGN KEY (`dependency_skill_id`) REFERENCES `ai_skills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_skill_prompt_templates` ADD CONSTRAINT `ai_skill_prompt_templates_skill_id_fkey` FOREIGN KEY (`skill_id`) REFERENCES `ai_skills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_skill_workflow_templates` ADD CONSTRAINT `ai_skill_workflow_templates_skill_id_fkey` FOREIGN KEY (`skill_id`) REFERENCES `ai_skills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_skill_plan_templates` ADD CONSTRAINT `ai_skill_plan_templates_skill_id_fkey` FOREIGN KEY (`skill_id`) REFERENCES `ai_skills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_skill_stage_templates` ADD CONSTRAINT `ai_skill_stage_templates_skill_id_fkey` FOREIGN KEY (`skill_id`) REFERENCES `ai_skills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_definitions` ADD CONSTRAINT `workflow_definitions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_definitions` ADD CONSTRAINT `workflow_definitions_current_version_id_fkey` FOREIGN KEY (`current_version_id`) REFERENCES `workflow_definition_versions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_definition_versions` ADD CONSTRAINT `workflow_definition_versions_workflow_id_fkey` FOREIGN KEY (`workflow_id`) REFERENCES `workflow_definitions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_definition_versions` ADD CONSTRAINT `workflow_definition_versions_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `app_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `object_storage_configs` ADD CONSTRAINT `object_storage_configs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generation_sessions` ADD CONSTRAINT `generation_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generation_records` ADD CONSTRAINT `generation_records_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generation_records` ADD CONSTRAINT `generation_records_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `generation_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generation_records` ADD CONSTRAINT `generation_records_provider_config_id_fkey` FOREIGN KEY (`provider_config_id`) REFERENCES `ai_provider_configs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `generation_outputs` ADD CONSTRAINT `generation_outputs_generation_record_id_fkey` FOREIGN KEY (`generation_record_id`) REFERENCES `generation_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_items` ADD CONSTRAINT `asset_items_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_items` ADD CONSTRAINT `asset_items_generation_record_id_fkey` FOREIGN KEY (`generation_record_id`) REFERENCES `generation_records`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_items` ADD CONSTRAINT `asset_items_generation_output_id_fkey` FOREIGN KEY (`generation_output_id`) REFERENCES `generation_outputs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_favorites` ADD CONSTRAINT `asset_favorites_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `asset_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_favorites` ADD CONSTRAINT `asset_favorites_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_runs` ADD CONSTRAINT `agent_runs_generation_record_id_fkey` FOREIGN KEY (`generation_record_id`) REFERENCES `generation_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_runs` ADD CONSTRAINT `agent_runs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_run_steps` ADD CONSTRAINT `agent_run_steps_agent_run_id_fkey` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_process_sections` ADD CONSTRAINT `agent_process_sections_agent_run_id_fkey` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
