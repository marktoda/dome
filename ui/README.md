# Onboarding UI

A simple onboarding flow with login and OAuth integration for GitHub and Notion, built with Next.js and deployable to Cloudflare Pages.

## Features

- Clean, responsive UI built with Next.js and Tailwind CSS
- Secure authentication with Dome Auth Service
- Email/password authentication
- OAuth integration with GitHub
- OAuth integration with Notion
- Protected routes with middleware
- Session management with tokens
- Ready for Cloudflare Pages deployment

## Auth Service Integration

This UI integrates with the Dome Auth service for secure user authentication:

- Authentication is done through the Dome Auth API
- NextAuth.js is used to handle session management
- Credentials are never stored in the UI, only tokens
- Token validation happens server-side
- Secure token revocation on logout
- OAuth providers connect through the Auth service

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (this project uses pnpm workspace structure)

### Installation

1. Navigate to the project directory:

```bash
cd ui
```

2. Install dependencies:

```bash
pnpm install
```

3. Set up environment variables by creating a `.env.local` file based on the provided template:

```bash
cp env.local.example .env.local
```

4. Edit the `.env.local` file with your specific configuration:
   - Set `NEXTAUTH_SECRET` to a secure random string
   - Update API URLs for your environment
   - Add OAuth client credentials if using GitHub or Notion

### Development

To start the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the application.

### Build for Production

To build the application for Cloudflare Pages:

```bash
pnpm run pages:build
```

## Deployment to Cloudflare Pages

This application is configured to be deployed to Cloudflare Pages using next-on-pages.

1. Build the application:

```bash
pnpm run pages:build
```

2. Deploy to Cloudflare Pages:

```bash
pnpm run pages:deploy
```

Alternatively, configure automatic deployments in the Cloudflare Pages dashboard:

1. Connect your repository to Cloudflare Pages
2. Configure the build settings:

   - Build command: `npm run pages:build`
   - Build output directory: `.vercel/output/static`
   - Root directory: `ui`

3. Configure the environment variables in the Cloudflare Pages dashboard with the values from `cloudflare-pages.json`

## Project Structure

- `app/` - Next.js app directory
  - `api/` - API routes for authentication with the auth service
  - `auth/` - Authentication pages (login, register, error)
  - `dashboard/` - Protected dashboard page
- `components/` - Reusable UI components
- `lib/` - Utility functions and authentication client
- `public/` - Static assets

## Authentication Flow

1. User navigates to the homepage
2. User selects login or register
3. User can authenticate with:
   - Email and password (validated against the auth service)
   - GitHub OAuth
   - Notion OAuth
4. Credentials are sent to the auth service, which returns a token
5. Token is stored in a secure HTTP-only cookie by NextAuth
6. After successful authentication, user is redirected to the dashboard
7. Protected routes are guarded by middleware which validates the token
8. On logout, token is revoked via the auth service

## OAuth Setup

To use OAuth providers:

1. Create OAuth apps in GitHub and Notion developer portals
2. Configure the callback URLs:
   - GitHub: `https://67143919.dome-8dm.pages.dev/api/auth/callback/github`
   - Notion: `https://67143919.dome-8dm.pages.dev/api/auth/callback/notion`
3. Add the client IDs and secrets to your environment variables

## License

MIT
