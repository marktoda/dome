# UI Integration with Existing Services

## System Architecture Diagram

```mermaid
graph TD
    subgraph "Client Layer"
        Browser[Web Browser]
    end

    subgraph "UI Application"
        NextJS[Next.js App]
        NextJS --> ServerComponents[Server Components]
        NextJS --> ClientComponents[Client Components]
        NextJS --> APIRoutes[API Routes]
        NextJS --> Middleware[Auth Middleware]
        
        ServerComponents --> ReactQuery[React Query/SWR]
        ClientComponents --> ZustandStore[Zustand Store]
        
        subgraph "Feature Modules"
            AuthModule[Authentication Module]
            ChatModule[Chat Interface Module]
            SearchModule[Search Module]
            SettingsModule[Settings Module]
        end
    end

    subgraph "Backend Services"
        AuthService[Auth Service]
        ChatService[Chat Service]
        SiloService[Silo Service]
        VectorizeDB[(Vectorize DB)]
        D1Database[(D1 Database)]
    end

    Browser <--> NextJS

    APIRoutes --> AuthClient[Auth API Client]
    APIRoutes --> ChatClient[Chat API Client]
    APIRoutes --> SearchClient[Search API Client]
    
    AuthClient --> AuthService
    ChatClient --> ChatService
    SearchClient --> SiloService
    
    ChatService --> VectorizeDB
    ChatService --> D1Database
    AuthService --> D1Database
    
    %% Data flow for authentication
    Middleware -- "Token Validation" --> AuthService
    AuthModule -- "Login/Register/OAuth" --> AuthClient
    
    %% Data flow for chat
    ChatModule -- "Message Streaming" --> ChatClient
    
    %% Data flow for search
    SearchModule -- "Query/Results" --> SearchClient
    
    style NextJS fill:#d4f1f9,stroke:#333,stroke-width:2px
    style AuthService fill:#f9d4d4,stroke:#333,stroke-width:2px
    style ChatService fill:#d4f9d4,stroke:#333,stroke-width:2px
```

## Communication Flow

```mermaid
sequenceDiagram
    participant User
    participant UI as UI Application
    participant Auth as Auth Service
    participant Chat as Chat Service
    participant Silo as Silo Service
    
    %% Authentication Flow
    User->>UI: Access protected page
    UI->>Auth: Validate token
    Auth-->>UI: Token valid/invalid
    
    alt Token Invalid
        UI->>User: Redirect to login
        User->>UI: Submit login credentials
        UI->>Auth: POST /login
        Auth-->>UI: Return token & user data
        UI->>User: Redirect to protected page
    end
    
    %% Chat Flow
    User->>UI: Send message
    UI->>Chat: POST /chat
    
    alt Streaming Enabled
        Chat-->>UI: Stream SSE response
        loop For each chunk
            UI-->>User: Update UI with chunk
        end
    else Normal Response
        Chat-->>UI: Complete response
        UI-->>User: Display response
    end
    
    %% Search Flow
    User->>UI: Submit search query
    UI->>Silo: POST /search
    Silo-->>UI: Return search results
    UI-->>User: Display search results
```

## OAuth Integration Flow

```mermaid
sequenceDiagram
    participant User
    participant UI as UI Application
    participant Auth as Auth Service
    participant OAuth as OAuth Provider (GitHub/Notion)
    
    User->>UI: Click "Sign in with GitHub/Notion"
    UI->>Auth: GET /oauth/authorize/:provider
    Auth-->>User: Redirect to OAuth provider
    User->>OAuth: Authorize application
    OAuth-->>Auth: Redirect with authorization code
    Auth->>OAuth: Exchange code for token
    OAuth-->>Auth: Return access token
    Auth->>Auth: Create/update user account
    Auth-->>UI: Redirect with session token
    UI-->>User: Authenticated session
```

## State Management

```mermaid
flowchart TD
    subgraph "Authentication State"
        AuthStore[Auth Store]
        AuthStore --> UserProfile[User Profile]
        AuthStore --> AuthStatus[Auth Status]
        AuthStore --> AuthActions[Auth Actions]
    end
    
    subgraph "Chat State"
        ChatStore[Chat Store]
        ChatStore --> ActiveChat[Active Chat]
        ChatStore --> Messages[Messages]
        ChatStore --> ChatActions[Chat Actions]
    end
    
    subgraph "Search State"
        SearchStore[Search Store]
        SearchStore --> Query[Search Query]
        SearchStore --> Filters[Search Filters]
        SearchStore --> Results[Search Results]
        SearchStore --> SearchActions[Search Actions]
    end
    
    subgraph "UI State"
        UIStore[UI Store]
        UIStore --> Theme[Theme]
        UIStore --> Sidebar[Sidebar State]
        UIStore --> Notifications[Notifications]
    end
    
    ServerState[Server State\nReact Query/SWR] --> RemoteData[Remote Data Cache]
    
    AuthStore --> ServerState
    ChatStore --> ServerState
    SearchStore --> ServerState
    
    style AuthStore fill:#f9d4d4,stroke:#333,stroke-width:2px
    style ChatStore fill:#d4f9d4,stroke:#333,stroke-width:2px
    style SearchStore fill:#d4d4f9,stroke:#333,stroke-width:2px
    style UIStore fill:#f9f9d4,stroke:#333,stroke-width:2px
    style ServerState fill:#d4f1f9,stroke:#333,stroke-width:2px