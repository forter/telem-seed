CREATE DATABASE IF NOT EXISTS webhooks;
USE webhooks;

CREATE TABLE IF NOT EXISTS subscribers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  topic VARCHAR(255) NOT NULL,
  url VARCHAR(2048) NOT NULL,
  headers JSON NOT NULL DEFAULT ('{}'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_subscribers_topic ON subscribers (topic);

CREATE TABLE IF NOT EXISTS topic_flags (
  topic VARCHAR(255) NOT NULL PRIMARY KEY,
  blocked TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subscriber_id INT NOT NULL,
  message_key VARCHAR(255),
  payload LONGTEXT NOT NULL,
  attempt_number INT NOT NULL DEFAULT 1,
  status ENUM('success', 'failed', 'exhausted', 'blocked') NOT NULL,
  http_status INT,
  error_message TEXT,
  delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);
