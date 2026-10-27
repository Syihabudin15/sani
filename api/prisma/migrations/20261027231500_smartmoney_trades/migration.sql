CREATE TABLE `smart_money_trades` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(30) NOT NULL,
    `aggregate_trade_id` BIGINT NOT NULL,
    `side` ENUM('TAKER_BUY', 'TAKER_SELL') NOT NULL,
    `price` DECIMAL(36, 12) NOT NULL,
    `quantity` DECIMAL(36, 12) NOT NULL,
    `notional_usdt` DECIMAL(36, 8) NOT NULL,
    `traded_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `smart_money_symbol_trade_key`(`symbol`, `aggregate_trade_id`),
    INDEX `smart_money_recent_side_idx`(`traded_at`, `side`),
    INDEX `smart_money_symbol_time_idx`(`symbol`, `traded_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
