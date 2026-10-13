import { type Knex } from 'knex';

// delivery: append-only record of every failed delivery attempt (spec 11 UC-DE-3, overview §4.7).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE shipment_attempts (
      id             UUID         NOT NULL DEFAULT uuidv7(),
      shipment_id    UUID         NOT NULL,
      attempt_number SMALLINT     NOT NULL,
      reason         VARCHAR(30)  NOT NULL,
      note           VARCHAR(500) NULL,
      agent_id       UUID         NOT NULL,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_shipment_attempts PRIMARY KEY (id),
      CONSTRAINT fk_shipment_attempts_shipment_id
        FOREIGN KEY (shipment_id) REFERENCES shipments (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index (D-10).
      CONSTRAINT fk_shipment_attempts_agent_id
        FOREIGN KEY (agent_id) REFERENCES delivery_agents (id) ON DELETE RESTRICT,
      -- No duplicate attempt numbers; also the attempts of a shipment: WHERE shipment_id = ANY(?)
      CONSTRAINT uq_shipment_attempts_shipment_id_attempt_number UNIQUE (shipment_id, attempt_number),
      CONSTRAINT chk_shipment_attempts_attempt_number CHECK (attempt_number BETWEEN 1 AND 3),
      CONSTRAINT chk_shipment_attempts_reason CHECK (reason IN (
        'customer_unreachable', 'customer_refused', 'wrong_address', 'customer_rescheduled'
      ))
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS shipment_attempts`);
}
