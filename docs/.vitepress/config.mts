import { defineConfig } from 'vitepress';

export default defineConfig({
    title: 'rtc-session-gateway',
    description: 'Carrier-neutral SIP, WebRTC, RTP, and recording gateway.',
    base: process.env.VITEPRESS_BASE || '/',
    cleanUrls: true,
    themeConfig: {
        search: {
            provider: 'local'
        },
        nav: [
            { text: 'Guide', link: '/guide/getting-started' },
            { text: 'Reference', link: '/reference/control-protocol' },
            { text: 'Development', link: '/development/testing' },
            { text: 'Plan', link: '/documentation-plan' }
        ],
        sidebar: [
            {
                text: 'Guide',
                items: [
                    { text: 'Getting Started', link: '/guide/getting-started' },
                    { text: 'Configuration', link: '/guide/configuration' },
                    { text: 'Control WebSocket', link: '/guide/control-websocket' },
                    { text: 'HTTP API', link: '/guide/http-api' },
                    { text: 'SIP Routing', link: '/guide/sip-routing' },
                    { text: 'Media Sessions', link: '/guide/media-sessions' },
                    { text: 'Recordings', link: '/guide/recordings' },
                    { text: 'Operations', link: '/guide/operations' }
                ]
            },
            {
                text: 'Reference',
                items: [
                    { text: 'Control Protocol', link: '/reference/control-protocol' },
                    { text: 'HTTP API', link: '/reference/http-api' },
                    { text: 'Events', link: '/reference/events' },
                    { text: 'Errors', link: '/reference/errors' }
                ]
            },
            {
                text: 'Development',
                items: [
                    { text: 'Testing', link: '/development/testing' },
                    { text: 'Local E2E', link: '/development/local-e2e' },
                    { text: 'Roadmap', link: '/roadmap' },
                    { text: 'Documentation Plan', link: '/documentation-plan' }
                ]
            }
        ],
        socialLinks: [
            { icon: 'github', link: 'https://github.com/zyno-io/rtc-session-gateway' }
        ],
        footer: {
            message: 'Released by Zyno Consulting.',
            copyright: 'Copyright Zyno Consulting'
        }
    }
});
