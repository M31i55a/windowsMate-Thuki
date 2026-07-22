import { motion } from 'framer-motion';

export function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="flex w-full justify-start py-1"
    >
      <div
        className="thinking-loader"
        role="status"
        aria-label="AI is thinking"
      />
    </motion.div>
  );
}
