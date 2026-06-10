# Frontend Setup

This is a React.js frontend application using Vite as the build tool.

## Installation

```bash
cd frontend
npm install
```

## Development

```bash
npm run dev
```

The app will run on http://localhost:3000

## Build

```bash
npm run build
```

## Features

- User Login & Registration
- Profile Image Upload
- Image Preview
- Responsive Design
- Protected Routes
- Token-based Authentication

## Environment Variables

Create a `.env` file based on `.env.example`. When using Docker Compose, keep `VITE_API_BASE_URL` empty so browser requests use the built-in same-origin `/api` proxy. For standalone frontend development, set `VITE_API_PROXY_TARGET` to the backend address.

```dotenv
VITE_API_BASE_URL=
VITE_API_PROXY_TARGET=http://localhost:8000
```
