.PHONY: help dev-up dev-down dev-logs dev-clean prod-up prod-down prod-logs build test lint install

# Default target
help:
	@echo "Dome2 RAG Platform - Available Commands:"
	@echo ""
	@echo "Development:"
	@echo "  make dev-up        - Start development environment"
	@echo "  make dev-down      - Stop development environment"
	@echo "  make dev-logs      - View development logs"
	@echo "  make dev-clean     - Clean development volumes and containers"
	@echo ""
	@echo "Production:"
	@echo "  make prod-up       - Start production environment"
	@echo "  make prod-down     - Stop production environment"
	@echo "  make prod-logs     - View production logs"
	@echo ""
	@echo "Development Tools:"
	@echo "  make install       - Install all dependencies"
	@echo "  make build         - Build all packages"
	@echo "  make test          - Run all tests"
	@echo "  make lint          - Run linters"
	@echo "  make typecheck     - Run TypeScript type checking"
	@echo ""
	@echo "Database:"
	@echo "  make db-migrate    - Run database migrations"
	@echo "  make db-seed       - Seed database with test data"
	@echo "  make db-reset      - Reset database"
	@echo ""
	@echo "Kafka:"
	@echo "  make kafka-topics  - Create Kafka topics"
	@echo "  make kafka-ui      - Open Kafka UI in browser"

# Development environment
dev-up:
	docker-compose -f docker-compose.dev.yml up -d
	@echo "Development environment started!"
	@echo "Services available at:"
	@echo "  - Kafka: localhost:9092"
	@echo "  - Kafka UI: http://localhost:8090"
	@echo "  - Weaviate: http://localhost:8080"
	@echo "  - Chroma: http://localhost:8000"
	@echo "  - PostgreSQL: localhost:5432"
	@echo "  - Redis: localhost:6379"

dev-down:
	docker-compose -f docker-compose.dev.yml down

dev-logs:
	docker-compose -f docker-compose.dev.yml logs -f

dev-clean:
	docker-compose -f docker-compose.dev.yml down -v --remove-orphans
	@echo "Development environment cleaned!"

# Production environment
prod-up:
	@if [ ! -f .env.prod ]; then \
		echo "Error: .env.prod file not found!"; \
		echo "Please create .env.prod with required environment variables"; \
		exit 1; \
	fi
	docker-compose -f docker-compose.prod.yml --env-file .env.prod up -d

prod-down:
	docker-compose -f docker-compose.prod.yml down

prod-logs:
	docker-compose -f docker-compose.prod.yml logs -f

# Development tools
install:
	pnpm install

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

typecheck:
	pnpm typecheck

# Database management
db-migrate:
	@echo "Running database migrations..."
	# TODO: Add migration command when migration tool is set up

db-seed:
	@echo "Seeding database..."
	# TODO: Add seed command when seed scripts are created

db-reset:
	@echo "Resetting database..."
	docker-compose -f docker-compose.dev.yml exec postgres psql -U dome2 -d dome2 -c "DROP SCHEMA IF EXISTS documents, auth, audit CASCADE;"
	docker-compose -f docker-compose.dev.yml exec postgres psql -U dome2 -d dome2 -f /docker-entrypoint-initdb.d/init.sql

# Kafka management
kafka-topics:
	@echo "Creating Kafka topics..."
	docker-compose -f docker-compose.dev.yml exec kafka kafka-topics --create --if-not-exists --topic github-events --bootstrap-server localhost:9092 --partitions 3 --replication-factor 1
	docker-compose -f docker-compose.dev.yml exec kafka kafka-topics --create --if-not-exists --topic notion-events --bootstrap-server localhost:9092 --partitions 3 --replication-factor 1
	docker-compose -f docker-compose.dev.yml exec kafka kafka-topics --create --if-not-exists --topic slack-events --bootstrap-server localhost:9092 --partitions 3 --replication-factor 1
	docker-compose -f docker-compose.dev.yml exec kafka kafka-topics --create --if-not-exists --topic linear-events --bootstrap-server localhost:9092 --partitions 3 --replication-factor 1
	docker-compose -f docker-compose.dev.yml exec kafka kafka-topics --create --if-not-exists --topic ingestion-dlq --bootstrap-server localhost:9092 --partitions 1 --replication-factor 1
	@echo "Kafka topics created!"

kafka-ui:
	@echo "Opening Kafka UI..."
	@command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:8090 || \
	command -v open >/dev/null 2>&1 && open http://localhost:8090 || \
	echo "Please open http://localhost:8090 in your browser"

# Quick development shortcuts
up: dev-up
down: dev-down
logs: dev-logs
clean: dev-clean 