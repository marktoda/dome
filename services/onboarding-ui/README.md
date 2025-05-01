# Onboarding UI

A simple onboarding flow with login and OAuth integration for GitHub and Notion, built with Next.js and deployable to Cloudflare Pages.

## Features

- Clean, responsive UI built with Next.js and Tailwind CSS
- Authentication with email/password
- OAuth integration with GitHub
- OAuth integration with Notion
- Protected routes with middleware
- Ready for Cloudflare Pages deployment

## Getting Started

### Prerequisites

- Node.js 18+ 
- pnpm (this project uses pnpm workspace structure)

### Installation

1. Navigate to the project directory:

```bash
cd services/onboarding-ui
```

2. Install dependencies:

```bash
pnpm install
```

3. Set up environment variables by creating a `.env.local` file:

```
# Base URL
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# NextAuth configuration
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-development-secret-value-change-this

# OAuth providers
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
NOTION_CLIENT_ID=your-notion-client-id
NOTION_CLIENT_SECRET=your-notion-client-secret
```

### Development

To start the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the application.

### Build for Production

To build the application for production:

```bash
pnpm build
```

## Deployment to Cloudflare Pages

This application is configured to be deployed to Cloudflare Pages. 

1. Create a new Cloudflare Pages project in the Cloudflare dashboard.

2. Connect your repository to Cloudflare Pages.

3. Configure the build settings:
   - Build command: `npm run build`
   - Build output directory: `.next/standalone`
   - Root directory: `services/onboarding-ui`

4. Set up the required environment variables in the Cloudflare Pages dashboard:
   - `NEXT_PUBLIC_BASE_URL`: Your Cloudflare Pages URL (e.g., https://your-project-name.pages.dev)
   - `NEXTAUTH_URL`: Same as your base URL
   - `NEXTAUTH_SECRET`: A strong, unique secret for production
   - `GITHUB_CLIENT_ID`: Your GitHub OAuth app's client ID
   - `GITHUB_CLIENT_SECRET`: Your GitHub OAuth app's client secret
   - `NOTION_CLIENT_ID`: Your Notion integration's client ID
   - `NOTION_CLIENT_SECRET`: Your Notion integration's client secret

5. Deploy the application.

## Project Structure

- `app/` - Next.js app directory
  - `api/` - API routes for authentication
  - `auth/` - Authentication pages (login, register, error)
  - `dashboard/` - Protected dashboard page
- `components/` - Reusable UI components
- `lib/` - Utility functions and type definitions
- `public/` - Static assets

## Authentication Flow

1. User navigates to the homepage
2. User selects login or register
3. User can authenticate with:
   - Email and password
   - GitHub OAuth
   - Notion OAuth
4. After successful authentication, user is redirected to the dashboard
5. Protected routes are guarded by middleware

## Notes

- This is a demonstration project with mock authentication
- In a production environment, you would:
  - Connect to a real database
  - Use proper password hashing
  - Implement proper error handling
  - Add more comprehensive testing
  - Set up proper security headers

## License

MIT