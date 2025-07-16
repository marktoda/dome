import React, { ReactNode, useEffect, useState, useMemo } from 'react';
import { Box, useStdout } from 'ink';

interface FullscreenLayoutProps {
  header: ReactNode;
  content: ReactNode;
  leftSidebar?: ReactNode;
  rightSidebar?: ReactNode;
  footer?: ReactNode;
}

export const FullscreenLayout = React.memo<FullscreenLayoutProps>(
  ({ header, content, leftSidebar, rightSidebar, footer }) => {
    const { stdout } = useStdout();
    const [dimensions, setDimensions] = useState({
      height: stdout?.rows || 24,
      width: stdout?.columns || 80,
    });

    // Handle terminal resize
    useEffect(() => {
      const handleResize = () => {
        setDimensions({
          height: stdout?.rows || 24,
          width: stdout?.columns || 80,
        });
      };

      process.stdout.on('resize', handleResize);
      return () => {
        process.stdout.off('resize', handleResize);
      };
    }, [stdout]);

    // Calculate dynamic sizes
    const headerHeight = 1;
    const footerHeight = footer ? 3 : 0;
    const contentAreaHeight = dimensions.height - headerHeight - footerHeight;

    // Sidebar width logic – keep it proportional but within sane bounds
    const sidebarWidth = useMemo(() => {
      const pct = 0.25; // 25% of available width
      const calculated = Math.floor(dimensions.width * pct);
      // Clamp to avoid extreme sizes on tiny/huge terminals
      return Math.max(20, Math.min(45, calculated));
    }, [dimensions.width]);

    return (
      <Box flexDirection="column" width={dimensions.width} height={dimensions.height}>
        {/* Sticky Header */}
        <Box height={headerHeight} flexShrink={0}>
          {header}
        </Box>

        {/* Main Content Area with Sidebars */}
        <Box flexDirection="row" height={contentAreaHeight} flexGrow={1}>
          {/* Left Sidebar */}
          {leftSidebar && (
            <Box width={sidebarWidth} flexShrink={0}>
              {leftSidebar}
            </Box>
          )}

          {/* Main Content - Scrollable */}
          <Box flexGrow={1} flexDirection="column" overflow="hidden">
            {content}
          </Box>

          {/* Right Sidebar */}
          {rightSidebar && (
            <Box width={sidebarWidth} flexShrink={0}>
              {rightSidebar}
            </Box>
          )}
        </Box>

        {/* Sticky Footer */}
        {footer && (
          <Box height={footerHeight} flexShrink={0}>
            {footer}
          </Box>
        )}
      </Box>
    );
  }
);

FullscreenLayout.displayName = 'FullscreenLayout';
