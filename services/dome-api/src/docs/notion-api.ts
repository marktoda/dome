/**
 * @openapi
 * components:
 *   schemas:
 *     NotionWorkspaceRegistration:
 *       type: object
 *       required:
 *         - workspaceId
 *       properties:
 *         workspaceId:
 *           type: string
 *           description: Unique identifier for the Notion workspace
 *         userId:
 *           type: string
 *           description: Optional user ID to associate with the sync plan
 *         cadence:
 *           type: string
 *           default: "PT1H"
 *           description: ISO8601 duration string for sync frequency (e.g., PT1H for 1 hour)
 *
 *     NotionOAuthConfiguration:
 *       type: object
 *       required:
 *         - code
 *         - redirectUri
 *       properties:
 *         code:
 *           type: string
 *           description: OAuth code received from Notion
 *         redirectUri:
 *           type: string
 *           format: uri
 *           description: Redirect URI that was used in the OAuth flow
 *         userId:
 *           type: string
 *           description: Optional user ID to associate with the OAuth token
 *
 *     NotionOAuthUrlRequest:
 *       type: object
 *       required:
 *         - redirectUri
 *       properties:
 *         redirectUri:
 *           type: string
 *           format: uri
 *           description: Redirect URI to use in the OAuth flow
 *         state:
 *           type: string
 *           description: Optional state parameter for the OAuth flow
 */

/**
 * @openapi
 * /content/notion:
 *   post:
 *     summary: Register a Notion workspace
 *     description: Register a Notion workspace for syncing
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NotionWorkspaceRegistration'
 *     responses:
 *       200:
 *         description: Workspace registered successfully
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 *
 * /content/notion/{workspaceId}/history:
 *   get:
 *     summary: Get Notion workspace sync history
 *     description: Retrieve the sync history for a specific Notion workspace
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: workspaceId
 *         in: path
 *         required: true
 *         description: Notion workspace ID
 *         schema:
 *           type: string
 *       - name: limit
 *         in: query
 *         required: false
 *         description: Maximum number of history records to return
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: History retrieved successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Server error
 *
 * /content/notion/{workspaceId}/sync:
 *   post:
 *     summary: Trigger Notion workspace sync
 *     description: Manually trigger a sync for a specific Notion workspace
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: workspaceId
 *         in: path
 *         required: true
 *         description: Notion workspace ID
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sync triggered successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Server error
 *
 * /content/notion/oauth:
 *   post:
 *     summary: Configure Notion OAuth
 *     description: Exchange OAuth code for token and configure Notion integration
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NotionOAuthConfiguration'
 *     responses:
 *       200:
 *         description: OAuth configured successfully
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 *
 * /content/notion/oauth/url:
 *   get:
 *     summary: Get Notion OAuth URL
 *     description: Generate an OAuth URL for Notion authorization
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NotionOAuthUrlRequest'
 *     responses:
 *       200:
 *         description: OAuth URL generated successfully
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 */
