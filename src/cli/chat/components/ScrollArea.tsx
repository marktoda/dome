import React, { useReducer, useRef, useEffect } from 'react';
import { Box, useInput, measureElement } from 'ink';

interface ScrollAreaProps {
  height: number;
  children: React.ReactNode;
}

type State = {
  height: number; // visible area height
  innerHeight: number; // total height of content
  scrollTop: number; // number of lines scrolled from top
};

type Action =
  | { type: 'SET_INNER_HEIGHT'; innerHeight: number }
  | { type: 'SCROLL_DOWN' }
  | { type: 'SCROLL_UP' };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'SET_INNER_HEIGHT': {
      const maxScroll = Math.max(action.innerHeight - state.height, 0);
      // If we were already at the bottom, keep us pinned to the bottom
      const atBottom = state.scrollTop >= maxScroll;
      return {
        ...state,
        innerHeight: action.innerHeight,
        scrollTop: atBottom ? maxScroll : state.scrollTop,
      };
    }
    case 'SCROLL_DOWN': {
      return {
        ...state,
        scrollTop: Math.min(Math.max(state.innerHeight - state.height, 0), state.scrollTop + 1),
      };
    }
    case 'SCROLL_UP': {
      return {
        ...state,
        scrollTop: Math.max(0, state.scrollTop - 1),
      };
    }
    default:
      return state;
  }
};

export const ScrollArea: React.FC<ScrollAreaProps> = ({ height, children }) => {
  const [state, dispatch] = React.useReducer(reducer, {
    height,
    innerHeight: 0,
    scrollTop: 0,
  });

  const innerRef = useRef<any>(null);

  // Re-measure on every render where children may change.
  useEffect(() => {
    if (innerRef.current) {
      const dimensions = measureElement(innerRef.current);
      dispatch({ type: 'SET_INNER_HEIGHT', innerHeight: dimensions.height });
    }
  }, [children]);

  // Arrow key handling
  useInput((_input, key) => {
    if (key.downArrow) {
      dispatch({ type: 'SCROLL_DOWN' });
    }
    if (key.upArrow) {
      dispatch({ type: 'SCROLL_UP' });
    }
  });

  return (
    <Box height={height} flexDirection="column" overflow="hidden">
      <Box ref={innerRef} flexShrink={0} flexDirection="column" marginTop={-state.scrollTop as any}>
        {children}
      </Box>
    </Box>
  );
};
