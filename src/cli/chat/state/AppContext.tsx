import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import { RootState, RootAction } from './types.js';
import { rootReducer, initialRootState } from './rootReducer.js';

interface AppContextType {
  state: RootState;
  dispatch: React.Dispatch<RootAction>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(rootReducer, initialRootState);
  
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppState = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppState must be used within AppProvider');
  }
  return context;
};

// Convenience hooks for specific parts of state
export const useChatState = () => {
  const { state } = useAppState();
  return state.chat;
};

export const useActivityState = () => {
  const { state } = useAppState();
  return state.activity;
};

export const useConfigState = () => {
  const { state } = useAppState();
  return state.cfg;
};

export const useUIState = () => {
  const { state } = useAppState();
  return state.ui;
};

export const useIndexingState = () => {
  const { state } = useAppState();
  return state.index;
};