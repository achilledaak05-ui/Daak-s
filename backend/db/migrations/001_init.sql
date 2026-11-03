-- Schéma Ouvrage : clients, prestataires, administration.
-- Montants en FCFA entiers. Dates en UTC. Appliqué automatiquement par scripts/migrate.js.
-- Toutes les tables ont une clé primaire (exigé par Aiven : sql_require_primary_key).

CREATE TABLE users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role          ENUM('client','pro','admin') NOT NULL,
  contact       VARCHAR(190) NOT NULL UNIQUE,            -- email ou téléphone, en minuscules sans espaces
  password_hash VARCHAR(255) NOT NULL,                   -- scrypt
  first_name    VARCHAR(80)  NOT NULL,
  last_name     VARCHAR(80)  NOT NULL,
  city          VARCHAR(80)  NOT NULL,
  zone          VARCHAR(120) NULL,
  status        ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role_status (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sessions des trois espaces : refresh token opaque, seul son SHA-256 est stocké
CREATE TABLE sessions (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  space       ENUM('client','pro','admin') NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_user (user_id, space)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_mfa (
  user_id         BIGINT UNSIGNED PRIMARY KEY,
  totp_secret_enc VARCHAR(255) NOT NULL,                 -- AES-256-GCM (DATA_KEY)
  enabled_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mfa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pro_profiles (
  user_id             BIGINT UNSIGNED PRIMARY KEY,
  bio                 TEXT NULL,
  base_price          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  verification_status ENUM('attente','valide','refuse','complement') NOT NULL DEFAULT 'attente',
  available           TINYINT(1) NOT NULL DEFAULT 1,
  rating_sum          INT UNSIGNED NOT NULL DEFAULT 0,
  rating_count        INT UNSIGNED NOT NULL DEFAULT 0,
  CONSTRAINT fk_pp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_pp_status (verification_status, available)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pro_trades (
  user_id BIGINT UNSIGNED NOT NULL,
  trade   VARCHAR(80) NOT NULL,
  PRIMARY KEY (user_id, trade),
  INDEX idx_pt_trade (trade),
  CONSTRAINT fk_pt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pro_zones (
  user_id BIGINT UNSIGNED NOT NULL,
  zone    VARCHAR(120) NOT NULL,
  PRIMARY KEY (user_id, zone),
  INDEX idx_pz_zone (zone),
  CONSTRAINT fk_pz_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pièces justificatives chiffrées, stockées en base (le disque de Render n'est pas persistant)
CREATE TABLE pro_documents (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  kind        ENUM('cni','naiss','diplome') NOT NULL,
  mime        VARCHAR(40) NOT NULL,
  size_bytes  INT UNSIGNED NOT NULL,
  sha256      CHAR(64) NOT NULL,
  content_enc MEDIUMBLOB NOT NULL,                       -- iv (12) | tag (16) | contenu chiffré
  is_current  TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_pd_user (user_id, kind, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commission_rates (
  trade      VARCHAR(80) PRIMARY KEY,
  rate       DECIMAL(5,2) NOT NULL DEFAULT 15.00,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_rate CHECK (rate BETWEEN 0 AND 50)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Demandes : le client décrit son besoin, l'administration l'envoie aux prestataires adaptés
CREATE TABLE requests (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ref         VARCHAR(20) NULL UNIQUE,                   -- DEM-<id>
  client_id   BIGINT UNSIGNED NOT NULL,
  trade       VARCHAR(80) NOT NULL,
  title       VARCHAR(120) NOT NULL,
  description TEXT NOT NULL,
  address     VARCHAR(255) NOT NULL,
  zone        VARCHAR(120) NOT NULL,
  urgency     ENUM('aujourdhui','semaine','libre') NOT NULL,
  desired_at  DATETIME NULL,
  status      ENUM('nouvelle','distribuee','proposee','choisie','annulee','expiree') NOT NULL DEFAULT 'nouvelle',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_req_client FOREIGN KEY (client_id) REFERENCES users(id),
  INDEX idx_req_status (status, trade, zone),
  INDEX idx_req_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Prestataires qui ont reçu une demande, et leur offre
CREATE TABLE request_pros (
  request_id  BIGINT UNSIGNED NOT NULL,
  pro_id      BIGINT UNSIGNED NOT NULL,
  status      ENUM('envoye','propose','accepte','refuse') NOT NULL DEFAULT 'envoye',
  price       BIGINT UNSIGNED NULL,
  message     VARCHAR(1000) NULL,
  sent_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, pro_id),
  CONSTRAINT fk_rp_req FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_pro FOREIGN KEY (pro_id) REFERENCES users(id),
  INDEX idx_rp_pro (pro_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bookings (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ref             VARCHAR(20) NULL UNIQUE,               -- RES-<id> ou DEV-<id>
  client_id       BIGINT UNSIGNED NOT NULL,
  pro_id          BIGINT UNSIGNED NOT NULL,
  request_id      BIGINT UNSIGNED NULL,
  trade           VARCHAR(80) NOT NULL,
  service         VARCHAR(120) NOT NULL,
  mode            ENUM('immediat','devis') NOT NULL,
  status          ENUM('attente','demande_devis','devis_propose','a_payer','payee','en_cours',
                       'fin_signalee','terminee','annulee','refusee','expiree','litige') NOT NULL,
  address         VARCHAR(255) NOT NULL,
  description     TEXT NOT NULL,
  scheduled_at    DATETIME NULL,
  price           BIGINT UNSIGNED NULL,
  commission_rate DECIMAL(5,2) NULL,                     -- figé quand le prix est accepté
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_b_client  FOREIGN KEY (client_id) REFERENCES users(id),
  CONSTRAINT fk_b_pro     FOREIGN KEY (pro_id) REFERENCES users(id),
  CONSTRAINT fk_b_request FOREIGN KEY (request_id) REFERENCES requests(id),
  INDEX idx_b_client_status (client_id, status),
  INDEX idx_b_pro_status (pro_id, status),
  INDEX idx_b_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payments (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id  BIGINT UNSIGNED NOT NULL,
  amount      BIGINT UNSIGNED NOT NULL,
  method      VARCHAR(40) NOT NULL,
  reference   VARCHAR(64) NOT NULL UNIQUE,
  status      ENUM('pending','success','failed','refund_pending','refunded') NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_p_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  INDEX idx_p_booking_status (booking_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reviews (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id  BIGINT UNSIGNED NOT NULL UNIQUE,
  client_id   BIGINT UNSIGNED NOT NULL,
  pro_id      BIGINT UNSIGNED NOT NULL,
  rating      TINYINT UNSIGNED NOT NULL,
  comment     VARCHAR(1000) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_r_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  CONSTRAINT fk_r_client  FOREIGN KEY (client_id) REFERENCES users(id),
  CONSTRAINT fk_r_pro     FOREIGN KEY (pro_id) REFERENCES users(id),
  INDEX idx_r_pro (pro_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE messages (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id  BIGINT UNSIGNED NOT NULL,
  sender_id   BIGINT UNSIGNED NOT NULL,
  body        VARCHAR(2000) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_m_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  CONSTRAINT fk_m_sender  FOREIGN KEY (sender_id) REFERENCES users(id),
  INDEX idx_m_booking (booking_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE disputes (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id  BIGINT UNSIGNED NOT NULL,
  opened_by   BIGINT UNSIGNED NOT NULL,
  type        VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  status      ENUM('ouvert','resolu') NOT NULL DEFAULT 'ouvert',
  decision    ENUM('client','pro') NULL,
  motif       VARCHAR(500) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_d_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  CONSTRAINT fk_d_user    FOREIGN KEY (opened_by) REFERENCES users(id),
  INDEX idx_d_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE favorites (
  user_id    BIGINT UNSIGNED NOT NULL,
  pro_id     BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, pro_id),
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_fav_pro  FOREIGN KEY (pro_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  kind       VARCHAR(40) NOT NULL,
  title      VARCHAR(160) NOT NULL,
  body       VARCHAR(500) NOT NULL DEFAULT '',
  read_at    DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_user (user_id, read_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Support : un fil de messages par client avec l'équipe Ouvrage
CREATE TABLE support_messages (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  sender     ENUM('client','support') NOT NULL,
  body       VARCHAR(2000) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sup_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sup_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE withdrawals (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ref        VARCHAR(20) NULL UNIQUE,                    -- RET-<id>
  user_id    BIGINT UNSIGNED NOT NULL,
  amount     BIGINT UNSIGNED NOT NULL,
  method     VARCHAR(40) NOT NULL,
  number_enc VARCHAR(255) NOT NULL,                      -- numéro de réception chiffré (DATA_KEY)
  status     ENUM('demande','en_cours','verse','rejete') NOT NULL DEFAULT 'demande',
  reason     VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_w_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_w_user_status (user_id, status),
  INDEX idx_w_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Journal d'audit : jamais modifié ni supprimé par l'application
CREATE TABLE audit_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id    BIGINT UNSIGNED NULL,
  action      VARCHAR(80) NOT NULL,
  entity      VARCHAR(40) NOT NULL,
  entity_id   VARCHAR(64) NOT NULL,
  meta        JSON NULL,
  ip          VARCHAR(64) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_entity (entity, entity_id),
  INDEX idx_audit_actor (actor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO commission_rates (trade, rate) VALUES
  ('Plomberie', 15.00), ('Électricité', 15.00), ('Menuiserie', 15.00), ('Peinture', 15.00),
  ('Maçonnerie', 15.00), ('Climatisation', 15.00), ('Nettoyage', 15.00), ('Autres services', 15.00);
